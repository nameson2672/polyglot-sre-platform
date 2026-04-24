using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Polly;
using Polly.Retry;
using StackExchange.Redis;
using OrdersApi.Data;
using OrdersApi.Telemetry;

namespace OrdersApi.Services;

public sealed class OutboxPublisher(
    IServiceScopeFactory scopeFactory,
    IConnectionMultiplexer redis,
    MetricsRegistry metrics,
    ILogger<OutboxPublisher> logger) : BackgroundService
{
    private static readonly ActivitySource ActivitySource = new(TelemetryConstants.ActivitySourceName);
    private const string StreamName = "orders.events";
    private const long AdvisoryLockId = 12345L;

    private readonly ResiliencePipeline _retryPipeline = new ResiliencePipelineBuilder()
        .AddRetry(new RetryStrategyOptions
        {
            MaxRetryAttempts = 5,
            BackoffType = DelayBackoffType.Exponential,
            Delay = TimeSpan.FromMilliseconds(200),
            OnRetry = args =>
            {
                var innerLogger = args.Context.Properties.GetValue(
                    new ResiliencePropertyKey<ILogger<OutboxPublisher>>("logger"), null!);
                innerLogger?.LogWarning("Outbox Redis retry {Attempt}: {Error}",
                    args.AttemptNumber, args.Outcome.Exception?.Message ?? "");
                return ValueTask.CompletedTask;
            }
        })
        .Build();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OutboxPublisher started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PublishBatchAsync(stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(ex, "OutboxPublisher unhandled error");
            }

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task PublishBatchAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();

        using var activity = ActivitySource.StartActivity("outbox.publish_batch");

        // Advisory lock prevents duplicate publishing across replicas
        var locked = await db.Database
            .SqlQueryRaw<bool>($"SELECT pg_try_advisory_lock({AdvisoryLockId})")
            .ToListAsync(ct);

        if (locked.Count == 0 || !locked[0])
        {
            logger.LogDebug("Could not acquire advisory lock, skipping batch");
            return;
        }

        try
        {
            var messages = await db.OutboxMessages
                .Where(m => m.PublishedAt == null)
                .OrderBy(m => m.Id)
                .Take(100)
                .ToListAsync(ct);

            if (messages.Count == 0)
            {
                metrics.SetOutboxLag(0);
                return;
            }

            var oldestAge = (DateTimeOffset.UtcNow - messages[0].CreatedAt).TotalSeconds;
            metrics.SetOutboxLag(oldestAge);

            activity?.SetTag("outbox.batch_size", messages.Count);

            var sw = Stopwatch.StartNew();
            int published = 0;

            var redisDb = redis.GetDatabase();

            foreach (var msg in messages)
            {
                try
                {
                    await _retryPipeline.ExecuteAsync(async token =>
                    {
                        await redisDb.StreamAddAsync(StreamName,
                        [
                            new NameValueEntry("event_id", msg.EventId.ToString()),
                            new NameValueEntry("event_type", msg.EventType),
                            new NameValueEntry("order_id", msg.AggregateId.ToString()),
                            new NameValueEntry("customer_id", ExtractCustomerId(msg.Payload)),
                            new NameValueEntry("occurred_at", msg.CreatedAt.ToString("O")),
                            new NameValueEntry("trace_id", Activity.Current?.TraceId.ToString() ?? ""),
                            new NameValueEntry("span_id", Activity.Current?.SpanId.ToString() ?? ""),
                            new NameValueEntry("payload", msg.Payload)
                        ]);
                    }, ct);

                    msg.PublishedAt = DateTimeOffset.UtcNow;
                    published++;

                    logger.LogInformation("Outbox message published {EventType} {EventId}",
                        msg.EventType, msg.EventId);
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Failed to publish outbox message {EventId} after retries", msg.EventId);
                }
            }

            await db.SaveChangesAsync(ct);

            sw.Stop();
            metrics.OutboxPublishDurationSeconds.Record(sw.Elapsed.TotalSeconds);
            activity?.SetTag("outbox.published_count", published);
        }
        finally
        {
            await db.Database
                .ExecuteSqlRawAsync($"SELECT pg_advisory_unlock({AdvisoryLockId})", ct);
        }
    }

    private static string ExtractCustomerId(string payload)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("customer_id", out var el))
                return el.GetString() ?? "";
            if (doc.RootElement.TryGetProperty("order", out var order) &&
                order.TryGetProperty("customerId", out var cid))
                return cid.GetString() ?? "";
        }
        catch (System.Text.Json.JsonException) { }
        return "";
    }
}

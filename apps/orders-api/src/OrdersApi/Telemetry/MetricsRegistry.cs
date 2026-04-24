using System.Diagnostics.Metrics;

namespace OrdersApi.Telemetry;

public sealed class MetricsRegistry : IDisposable
{
    private readonly Meter _meter;
    private double _outboxLagSeconds;

    public Counter<long> OrdersCreatedTotal { get; }
    public Counter<long> OrdersStatusTransitionsTotal { get; }
    public ObservableGauge<double> OutboxLagSeconds { get; }
    public Histogram<double> OutboxPublishDurationSeconds { get; }
    public Counter<long> IdempotencyHitsTotal { get; }

    public MetricsRegistry()
    {
        _meter = new Meter(TelemetryConstants.MeterName);

        OrdersCreatedTotal = _meter.CreateCounter<long>(
            "orders_created_total",
            description: "Total orders created");

        OrdersStatusTransitionsTotal = _meter.CreateCounter<long>(
            "orders_status_transitions_total",
            description: "Total order status transitions");

        OutboxLagSeconds = _meter.CreateObservableGauge<double>(
            "outbox_lag_seconds",
            () => _outboxLagSeconds,
            description: "Age of oldest unpublished outbox row in seconds");

        OutboxPublishDurationSeconds = _meter.CreateHistogram<double>(
            "outbox_publish_duration_seconds",
            unit: "s",
            description: "Duration to publish outbox batch to Redis");

        IdempotencyHitsTotal = _meter.CreateCounter<long>(
            "idempotency_hits_total",
            description: "Total idempotency cache hits");
    }

    public void SetOutboxLag(double seconds) => _outboxLagSeconds = seconds;

    public void Dispose() => _meter.Dispose();
}

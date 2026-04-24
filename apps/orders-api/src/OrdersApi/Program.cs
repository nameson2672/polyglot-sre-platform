using FluentValidation;
using Microsoft.EntityFrameworkCore;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;
using Serilog.Events;
using StackExchange.Redis;
using OrdersApi.Configuration;
using OrdersApi.Data;
using OrdersApi.Endpoints;
using OrdersApi.Features.Orders;
using OrdersApi.Middleware;
using OrdersApi.Services;
using OrdersApi.Telemetry;

// Bootstrap logger for startup errors
Serilog.Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
    .WriteTo.Console()
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    // Env var overrides (map from env var naming convention to config sections)
    builder.Configuration
        .AddEnvironmentVariables()
        .AddInMemoryCollection(MapEnvVars(builder.Configuration));

    // Serilog
    builder.Host.UseSerilog((ctx, services, config) =>
    {
        config
            .ReadFrom.Configuration(ctx.Configuration)
            .ReadFrom.Services(services)
            .MinimumLevel.Override("Microsoft.EntityFrameworkCore", LogEventLevel.Warning)
            .Enrich.FromLogContext()
            .Enrich.WithEnvironmentName()
            .Enrich.WithMachineName()
            .WriteTo.Console(new Serilog.Formatting.Json.JsonFormatter());
    });

    // Options with validation
    builder.Services
        .AddOptions<DatabaseOptions>()
        .Bind(builder.Configuration.GetSection(DatabaseOptions.Section))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    builder.Services
        .AddOptions<RedisOptions>()
        .Bind(builder.Configuration.GetSection(RedisOptions.Section))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    builder.Services
        .AddOptions<ApiOptions>()
        .Bind(builder.Configuration.GetSection(ApiOptions.Section))
        .ValidateDataAnnotations()
        .ValidateOnStart();

    builder.Services.AddOptions<OtelOptions>()
        .Bind(builder.Configuration.GetSection(OtelOptions.Section));

    // EF Core — CHAOS: Maximum Pool Size=5 intentionally small for connection exhaustion demo
    builder.Services.AddDbContext<OrdersDbContext>((sp, opts) =>
    {
        var dbOpts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<DatabaseOptions>>().Value;
        var connStr = dbOpts.ConnectionString;
        if (!connStr.Contains("Maximum Pool Size", StringComparison.OrdinalIgnoreCase))
            connStr += ";Maximum Pool Size=5";
        opts.UseNpgsql(connStr);
    });

    // Redis — strip redis:// scheme prefix since StackExchange.Redis uses host:port format
    builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
    {
        var redisOpts = sp.GetRequiredService<Microsoft.Extensions.Options.IOptions<RedisOptions>>().Value;
        var url = redisOpts.Url;
        if (url.StartsWith("redis://", StringComparison.OrdinalIgnoreCase))
            url = url["redis://".Length..];
        return ConnectionMultiplexer.Connect(url);
    });

    // OpenTelemetry
    var otelEndpoint = builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4317";
    builder.Services.AddOpenTelemetry()
        .ConfigureResource(r => r.AddService(TelemetryConstants.ServiceName))
        .WithTracing(t => t
            .AddSource(TelemetryConstants.ActivitySourceName)
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddEntityFrameworkCoreInstrumentation()
            .AddOtlpExporter(o => o.Endpoint = new Uri(otelEndpoint)))
        .WithMetrics(m => m
            .AddMeter(TelemetryConstants.MeterName)
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddRuntimeInstrumentation()
            .AddPrometheusExporter());

    // Application services
    builder.Services.AddSingleton<MetricsRegistry>();
    builder.Services.AddScoped<IdempotencyService>();
    builder.Services.AddHostedService<OutboxPublisher>();

    // Validators
    builder.Services.AddScoped<IValidator<CreateOrderRequest>, CreateOrderValidator>();

    // OpenAPI
    builder.Services.AddOpenApi();

    // Problem details
    builder.Services.AddProblemDetails();

    var app = builder.Build();

    app.UseMiddleware<ProblemDetailsMiddleware>();
    app.UseMiddleware<CorrelationIdMiddleware>();

    app.UseSerilogRequestLogging(opts =>
    {
        opts.GetLevel = (ctx, _, _) => LogEventLevel.Debug;
    });

    app.MapOpenApi();
    app.MapPrometheusScrapingEndpoint("/metrics");

    app.MapHealthEndpoints();
    app.MapOrdersEndpoints();

    app.Run();
}
catch (Exception ex)
{
    Serilog.Log.Fatal(ex, "Application start-up failed");
    throw;
}
finally
{
    Serilog.Log.CloseAndFlush();
}

static IEnumerable<KeyValuePair<string, string?>> MapEnvVars(IConfiguration cfg)
{
    var map = new Dictionary<string, string?>();

    var pg = cfg["POSTGRES_CONNECTION_STRING"];
    if (!string.IsNullOrEmpty(pg))
        map["Database:ConnectionString"] = pg;

    var redis = cfg["REDIS_URL"];
    if (!string.IsNullOrEmpty(redis))
        map["Redis:Url"] = redis;

    var apiKey = cfg["ORDERS_API_KEY"];
    if (!string.IsNullOrEmpty(apiKey))
        map["Api:ApiKey"] = apiKey;

    var otlp = cfg["OTEL_EXPORTER_OTLP_ENDPOINT"];
    if (!string.IsNullOrEmpty(otlp))
        map["Otel:OtlpEndpoint"] = otlp;

    return map;
}

// Needed for test project integration
public partial class Program { }

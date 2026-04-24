using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;
using OrdersApi.Data;

namespace OrdersApi.Endpoints;

public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }))
            .WithName("Liveness")
            .AllowAnonymous();

        app.MapGet("/readyz", async (OrdersDbContext db, IConnectionMultiplexer redis, CancellationToken ct) =>
        {
            var checks = new Dictionary<string, string>();
            try
            {
                await db.Database.ExecuteSqlRawAsync("SELECT 1", ct);
                checks["postgres"] = "ok";
            }
            catch (Exception ex)
            {
                checks["postgres"] = $"error: {ex.Message}";
            }

            try
            {
                var redisDb = redis.GetDatabase();
                await redisDb.PingAsync();
                checks["redis"] = "ok";
            }
            catch (Exception ex)
            {
                checks["redis"] = $"error: {ex.Message}";
            }

            var allOk = checks.Values.All(v => v == "ok");
            return allOk
                ? Results.Ok(new { status = "ready", checks })
                : Results.Json(new { status = "unhealthy", checks }, statusCode: StatusCodes.Status503ServiceUnavailable);
        })
        .WithName("Readiness")
        .AllowAnonymous();

        app.MapGet("/info", (IConfiguration config) => Results.Ok(new
        {
            service = "orders-api",
            version = typeof(HealthEndpoints).Assembly.GetName().Version?.ToString() ?? "1.0.0",
            commit = config["GIT_COMMIT"] ?? "unknown",
            build_time = config["BUILD_TIME"] ?? "unknown",
            framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription
        }))
        .WithName("Info")
        .AllowAnonymous();
    }
}

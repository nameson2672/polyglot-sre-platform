namespace OrdersApi.Endpoints;

public static class DebugEndpoints
{
    public static void MapDebugEndpoints(this RouteGroupBuilder group)
    {
        // CHAOS: intentional 2-second sleep for latency SLO breach demos
        group.MapGet("/slow", async (CancellationToken ct) =>
        {
            await Task.Delay(2000, ct);
            return Results.Ok(new { message = "slow response", delay_ms = 2000 });
        })
        .WithName("SlowEndpoint");
    }
}

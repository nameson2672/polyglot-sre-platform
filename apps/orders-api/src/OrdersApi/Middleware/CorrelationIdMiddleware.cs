using System.Diagnostics;

namespace OrdersApi.Middleware;

public sealed class CorrelationIdMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var traceParent = Activity.Current?.Id ?? Guid.NewGuid().ToString();
        context.Response.Headers["traceparent"] = traceParent;

        await next(context);
    }
}

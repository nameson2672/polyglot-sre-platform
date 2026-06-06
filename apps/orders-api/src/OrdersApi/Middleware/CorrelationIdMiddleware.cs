using System.Diagnostics;
using Serilog.Context;

namespace OrdersApi.Middleware;

public sealed class CorrelationIdMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var traceId = Activity.Current?.TraceId.ToString() ?? Guid.NewGuid().ToString("N");
        context.Response.Headers["traceparent"] = Activity.Current?.Id ?? traceId;

        using (LogContext.PushProperty("trace_id", traceId))
        {
            await next(context);
        }
    }
}

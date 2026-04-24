using System.Text.Json;
using FluentValidation;
using Microsoft.AspNetCore.Mvc;
using OrdersApi.Configuration;
using OrdersApi.Data;
using OrdersApi.Features.Orders;
using OrdersApi.Services;
using OrdersApi.Telemetry;
using Microsoft.Extensions.Options;

namespace OrdersApi.Endpoints;

public static class OrdersEndpoints
{
    public static void MapOrdersEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/v1/orders")
            .AddEndpointFilter<ApiKeyFilter>()
            .WithOpenApi();

        group.MapPost("/", async (
            HttpContext httpContext,
            OrdersDbContext db,
            IdempotencyService idempotency,
            MetricsRegistry metrics,
            IValidator<CreateOrderRequest> validator,
            ILogger<CreateOrderRequest> logger,
            CancellationToken ct) =>
        {
            if (!TryGetIdempotencyKey(httpContext, out var idemKey))
                return Results.Problem(title: "Missing or invalid Idempotency-Key header", statusCode: 400);

            string rawBody;
            CreateOrderRequest? request;
            try
            {
                using var reader = new StreamReader(httpContext.Request.Body);
                rawBody = await reader.ReadToEndAsync(ct);
                request = JsonSerializer.Deserialize<CreateOrderRequest>(rawBody);
                if (request is null)
                    return Results.Problem(title: "Invalid JSON body", statusCode: 400);
            }
            catch (JsonException ex)
            {
                return Results.Problem(title: "Invalid JSON", detail: ex.Message, statusCode: 400);
            }

            var validation = await validator.ValidateAsync(request, ct);
            if (!validation.IsValid)
                return Results.ValidationProblem(validation.ToDictionary());

            return await CreateOrder.HandleAsync(request, rawBody, idemKey, db, idempotency, metrics, logger, httpContext, ct);
        })
        .WithName("CreateOrder")
        .Accepts<CreateOrderRequest>("application/json")
        .Produces<OrderResponse>(201)
        .ProducesValidationProblem()
        .Produces<ProblemDetails>(409)
        .Produces<ProblemDetails>(503);

        group.MapGet("/{id}", (string id, OrdersDbContext db, CancellationToken ct) =>
            GetOrder.HandleAsync(id, db, ct))
        .WithName("GetOrder")
        .Produces<OrderResponse>(200)
        .Produces<ProblemDetails>(400)
        .Produces<ProblemDetails>(404);

        group.MapGet("/", (
            HttpContext httpContext,
            OrdersDbContext db,
            int page = 1,
            int page_size = 20,
            CancellationToken ct = default) =>
            ListOrders.HandleAsync(page, page_size, db, httpContext, ct))
        .WithName("ListOrders")
        .Produces(200);

        group.MapPatch("/{id}", (
            string id,
            UpdateOrderStatusRequest request,
            OrdersDbContext db,
            MetricsRegistry metrics,
            ILogger<UpdateOrderStatusRequest> logger,
            CancellationToken ct) =>
            UpdateOrderStatus.HandleAsync(id, request, db, metrics, logger, ct))
        .WithName("UpdateOrderStatus")
        .Produces<OrderResponse>(200)
        .Produces<ProblemDetails>(404)
        .Produces<ProblemDetails>(422);

        group.MapDelete("/{id}", (
            string id,
            OrdersDbContext db,
            MetricsRegistry metrics,
            ILogger<CancelOrderHandler> logger,
            CancellationToken ct) =>
            CancelOrder.HandleAsync(id, db, metrics, logger, ct))
        .WithName("CancelOrder")
        .Produces(204)
        .Produces<ProblemDetails>(404);

        group.MapDebugEndpoints();
    }

    private static bool TryGetIdempotencyKey(HttpContext ctx, out Guid key)
    {
        key = Guid.Empty;
        if (!ctx.Request.Headers.TryGetValue("Idempotency-Key", out var raw))
            return false;
        return Guid.TryParse(raw, out key);
    }
}

public sealed class ApiKeyFilter(IOptions<ApiOptions> options) : IEndpointFilter
{
    private readonly string _expectedKey = options.Value.ApiKey;

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        if (!context.HttpContext.Request.Headers.TryGetValue("X-Api-Key", out var key) || key != _expectedKey)
        {
            return Results.Json(
                new { title = "Unauthorized", detail = "Missing or invalid X-Api-Key" },
                statusCode: StatusCodes.Status401Unauthorized);
        }
        return await next(context);
    }
}

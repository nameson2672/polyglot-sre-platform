using System.Text.Json;
using System.Text.Json.Serialization;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using OrdersApi.Data;
using OrdersApi.Domain;
using OrdersApi.Services;
using OrdersApi.Telemetry;

namespace OrdersApi.Features.Orders;

public sealed record CreateOrderRequest(
    [property: JsonPropertyName("customer_id")] Guid CustomerId,
    [property: JsonPropertyName("items")] List<CreateOrderItemRequest> Items,
    [property: JsonPropertyName("currency")] string Currency
);

public sealed record CreateOrderItemRequest(
    [property: JsonPropertyName("sku")] string Sku,
    [property: JsonPropertyName("qty")] int Qty,
    [property: JsonPropertyName("unit_price_cents")] long UnitPriceCents
);

public sealed record OrderResponse(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("customer_id")] Guid CustomerId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("total_cents")] long TotalCents,
    [property: JsonPropertyName("currency")] string Currency,
    [property: JsonPropertyName("items")] List<OrderItemResponse> Items,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("updated_at")] DateTimeOffset UpdatedAt
);

public sealed record OrderItemResponse(
    [property: JsonPropertyName("line_no")] int LineNo,
    [property: JsonPropertyName("sku")] string Sku,
    [property: JsonPropertyName("qty")] int Qty,
    [property: JsonPropertyName("unit_price_cents")] long UnitPriceCents
);

public sealed class CreateOrderValidator : AbstractValidator<CreateOrderRequest>
{
    public CreateOrderValidator()
    {
        RuleFor(r => r.CustomerId).NotEmpty();
        RuleFor(r => r.Currency).NotEmpty().Length(3);
        RuleFor(r => r.Items).NotEmpty();
        RuleForEach(r => r.Items).ChildRules(item =>
        {
            item.RuleFor(i => i.Sku).NotEmpty().MaximumLength(100);
            item.RuleFor(i => i.Qty).GreaterThan(0);
            item.RuleFor(i => i.UnitPriceCents).GreaterThanOrEqualTo(0);
        });
    }
}

public static class CreateOrder
{
    public static OrderResponse MapToResponse(Order order) => new(
        order.Id,
        order.CustomerId,
        order.Status.ToDbString(),
        order.TotalCents,
        order.Currency,
        order.Items.Select(i => new OrderItemResponse(i.LineNo, i.Sku, i.Qty, i.UnitPriceCents)).ToList(),
        order.CreatedAt,
        order.UpdatedAt
    );

    public static async Task<IResult> HandleAsync(
        CreateOrderRequest request,
        string rawBody,
        Guid idempotencyKey,
        OrdersDbContext db,
        IdempotencyService idempotency,
        MetricsRegistry metrics,
        ILogger<CreateOrderRequest> logger,
        HttpContext httpContext,
        CancellationToken ct)
    {
        var existing = await idempotency.FindAsync(idempotencyKey, ct);
        if (existing != null)
        {
            var requestHash = IdempotencyService.HashBody(rawBody);
            if (existing.RequestHash != requestHash)
            {
                metrics.IdempotencyHitsTotal.Add(1,
                    new KeyValuePair<string, object?>("conflict", true));
                return Results.Conflict(new { title = "Idempotency conflict", detail = "Same key, different body" });
            }

            metrics.IdempotencyHitsTotal.Add(1,
                new KeyValuePair<string, object?>("conflict", false));
            logger.LogInformation("Idempotency hit for key {Key}", idempotencyKey);
            var cached = JsonSerializer.Deserialize<OrderResponse>(existing.ResponseBody)!;
            return Results.Json(cached, statusCode: existing.ResponseCode);
        }

        var now = DateTimeOffset.UtcNow;
        var order = new Order
        {
            Id = Guid.NewGuid(),
            CustomerId = request.CustomerId,
            Status = OrderStatus.Pending,
            Currency = request.Currency.ToUpperInvariant(),
            CreatedAt = now,
            UpdatedAt = now,
            Items = request.Items.Select((item, idx) => new OrderItem
            {
                Sku = item.Sku,
                Qty = item.Qty,
                UnitPriceCents = item.UnitPriceCents,
                LineNo = idx + 1
            }).ToList()
        };
        order.TotalCents = order.Items.Sum(i => i.UnitPriceCents * i.Qty);

        var payload = JsonSerializer.Serialize(new
        {
            order = new { id = order.Id, customerId = order.CustomerId, status = order.Status.ToDbString(), totalCents = order.TotalCents, currency = order.Currency },
            customer_id = order.CustomerId,
            source = "orders-api"
        });

        var outbox = new OutboxMessage
        {
            EventId = Guid.NewGuid(),
            EventType = "order.created",
            AggregateId = order.Id,
            Payload = payload,
            CreatedAt = now
        };

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.Orders.Add(order);
        db.OutboxMessages.Add(outbox);
        await db.SaveChangesAsync(ct);

        var response = MapToResponse(order);
        var idempotencyRecord = new IdempotencyRecord
        {
            Key = idempotencyKey,
            RequestHash = IdempotencyService.HashBody(rawBody),
            ResponseBody = JsonSerializer.Serialize(response),
            ResponseCode = 201,
            CreatedAt = now
        };
        db.IdempotencyKeys.Add(idempotencyRecord);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        metrics.OrdersCreatedTotal.Add(1,
            new KeyValuePair<string, object?>("currency", order.Currency),
            new KeyValuePair<string, object?>("status", order.Status.ToDbString()));

        logger.LogInformation("Order created {OrderId} for customer {CustomerId}", order.Id, order.CustomerId);

        var locationUrl = $"{httpContext.Request.Scheme}://{httpContext.Request.Host}/v1/orders/{order.Id}";
        return Results.Created(locationUrl, response);
    }
}

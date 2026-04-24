using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using OrdersApi.Data;
using OrdersApi.Domain;
using OrdersApi.Telemetry;

namespace OrdersApi.Features.Orders;

public sealed record UpdateOrderStatusRequest(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("reason")] string? Reason = null
);

public static class UpdateOrderStatus
{
    public static async Task<IResult> HandleAsync(
        string id,
        UpdateOrderStatusRequest request,
        OrdersDbContext db,
        MetricsRegistry metrics,
        ILogger<UpdateOrderStatusRequest> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var guid))
            return Results.Problem(title: "Invalid UUID", statusCode: 400);

        if (!TryParseStatus(request.Status, out var newStatus))
            return Results.Problem(title: "Invalid status value", statusCode: 400);

        var order = await db.Orders
            .Include(o => o.Items)
            .FirstOrDefaultAsync(o => o.Id == guid, ct);

        if (order is null)
            return Results.NotFound(new { title = "Order not found" });

        var prevStatus = order.Status;
        if (!prevStatus.CanTransitionTo(newStatus))
        {
            return Results.UnprocessableEntity(new
            {
                title = "Invalid status transition",
                detail = $"Cannot transition from '{prevStatus.ToDbString()}' to '{request.Status}'"
            });
        }

        order.Status = newStatus;
        order.UpdatedAt = DateTimeOffset.UtcNow;

        var payload = JsonSerializer.Serialize(new
        {
            orderId = order.Id,
            previousStatus = prevStatus.ToDbString(),
            newStatus = newStatus.ToDbString(),
            reason = request.Reason,
            customer_id = order.CustomerId,
            source = "orders-api"
        });

        var eventType = newStatus switch
        {
            OrderStatus.Confirmed => "order.confirmed",
            OrderStatus.Shipped => "order.shipped",
            OrderStatus.Cancelled => "order.cancelled",
            _ => "order.updated"
        };

        var outbox = new OutboxMessage
        {
            EventId = Guid.NewGuid(),
            EventType = eventType,
            AggregateId = order.Id,
            Payload = payload,
            CreatedAt = DateTimeOffset.UtcNow
        };

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.OutboxMessages.Add(outbox);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        metrics.OrdersStatusTransitionsTotal.Add(1,
            new KeyValuePair<string, object?>("from_status", prevStatus.ToDbString()),
            new KeyValuePair<string, object?>("to_status", newStatus.ToDbString()));

        logger.LogInformation("Order {OrderId} transitioned {From} -> {To}",
            order.Id, prevStatus.ToDbString(), newStatus.ToDbString());

        return Results.Ok(CreateOrder.MapToResponse(order));
    }

    private static bool TryParseStatus(string raw, out OrderStatus status)
    {
        try
        {
            status = OrderStatusExtensions.FromDbString(raw.ToLowerInvariant());
            return true;
        }
        catch
        {
            status = default;
            return false;
        }
    }
}

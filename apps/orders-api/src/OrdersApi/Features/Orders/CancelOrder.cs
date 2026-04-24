using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using OrdersApi.Data;
using OrdersApi.Domain;
using OrdersApi.Telemetry;

namespace OrdersApi.Features.Orders;

public sealed class CancelOrderHandler; // type token for ILogger generic

public static class CancelOrder
{
    public static async Task<IResult> HandleAsync(
        string id,
        OrdersDbContext db,
        MetricsRegistry metrics,
        ILogger<CancelOrderHandler> logger,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var guid))
            return Results.Problem(title: "Invalid UUID", statusCode: 400);

        var order = await db.Orders.FindAsync([guid], ct);
        if (order is null)
            return Results.NotFound(new { title = "Order not found" });

        if (!order.Status.CanTransitionTo(OrderStatus.Cancelled))
        {
            return Results.UnprocessableEntity(new
            {
                title = "Invalid status transition",
                detail = $"Cannot cancel order in status '{order.Status.ToDbString()}'"
            });
        }

        var prevStatus = order.Status;
        order.Status = OrderStatus.Cancelled;
        order.UpdatedAt = DateTimeOffset.UtcNow;

        var payload = JsonSerializer.Serialize(new
        {
            orderId = order.Id,
            previousStatus = prevStatus.ToDbString(),
            newStatus = "cancelled",
            customer_id = order.CustomerId,
            source = "orders-api"
        });

        var outbox = new OutboxMessage
        {
            EventId = Guid.NewGuid(),
            EventType = "order.cancelled",
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
            new KeyValuePair<string, object?>("to_status", "cancelled"));

        logger.LogInformation("Order {OrderId} cancelled", order.Id);

        return Results.NoContent();
    }
}

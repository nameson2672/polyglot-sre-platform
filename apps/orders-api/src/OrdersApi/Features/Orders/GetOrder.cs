using Microsoft.EntityFrameworkCore;
using OrdersApi.Data;

namespace OrdersApi.Features.Orders;

public static class GetOrder
{
    public static async Task<IResult> HandleAsync(
        string id,
        OrdersDbContext db,
        CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var guid))
            return Results.Problem(
                title: "Invalid UUID",
                detail: $"'{id}' is not a valid UUID",
                statusCode: StatusCodes.Status400BadRequest);

        var order = await db.Orders
            .Include(o => o.Items)
            .FirstOrDefaultAsync(o => o.Id == guid, ct);

        if (order is null)
            return Results.NotFound(new { title = "Order not found", detail = $"Order {id} does not exist" });

        return Results.Ok(CreateOrder.MapToResponse(order));
    }
}

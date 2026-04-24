using Microsoft.EntityFrameworkCore;
using OrdersApi.Data;

namespace OrdersApi.Features.Orders;

public static class ListOrders
{
    public static async Task<IResult> HandleAsync(
        int page,
        int pageSize,
        OrdersDbContext db,
        HttpContext httpContext,
        CancellationToken ct)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var total = await db.Orders.CountAsync(ct);
        var orders = await db.Orders
            .Include(o => o.Items)
            .OrderByDescending(o => o.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync(ct);

        var items = orders.Select(CreateOrder.MapToResponse).ToList();
        var totalPages = (int)Math.Ceiling(total / (double)pageSize);

        var baseUrl = $"{httpContext.Request.Scheme}://{httpContext.Request.Host}/v1/orders";
        var links = new List<string>();
        if (page > 1)
            links.Add($"<{baseUrl}?page={page - 1}&page_size={pageSize}>; rel=\"prev\"");
        if (page < totalPages)
            links.Add($"<{baseUrl}?page={page + 1}&page_size={pageSize}>; rel=\"next\"");
        links.Add($"<{baseUrl}?page=1&page_size={pageSize}>; rel=\"first\"");
        links.Add($"<{baseUrl}?page={totalPages}&page_size={pageSize}>; rel=\"last\"");

        if (links.Count > 0)
            httpContext.Response.Headers["Link"] = string.Join(", ", links);

        return Results.Ok(new { total, page, page_size = pageSize, items });
    }
}

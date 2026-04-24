namespace OrdersApi.Domain;

public sealed class Order
{
    public Guid Id { get; set; }
    public Guid CustomerId { get; set; }
    public OrderStatus Status { get; set; }
    public long TotalCents { get; set; }
    public string Currency { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public List<OrderItem> Items { get; set; } = [];
}

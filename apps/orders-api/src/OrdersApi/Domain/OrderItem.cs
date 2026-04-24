namespace OrdersApi.Domain;

public sealed class OrderItem
{
    public Guid OrderId { get; set; }
    public int LineNo { get; set; }
    public string Sku { get; set; } = string.Empty;
    public int Qty { get; set; }
    public long UnitPriceCents { get; set; }

    public Order? Order { get; set; }
}

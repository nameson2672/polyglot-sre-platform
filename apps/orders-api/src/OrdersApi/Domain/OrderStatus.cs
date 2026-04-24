namespace OrdersApi.Domain;

public enum OrderStatus
{
    Pending,
    Confirmed,
    Shipped,
    Cancelled
}

public static class OrderStatusExtensions
{
    public static string ToDbString(this OrderStatus s) => s switch
    {
        OrderStatus.Pending => "pending",
        OrderStatus.Confirmed => "confirmed",
        OrderStatus.Shipped => "shipped",
        OrderStatus.Cancelled => "cancelled",
        _ => throw new ArgumentOutOfRangeException(nameof(s))
    };

    public static OrderStatus FromDbString(string s) => s switch
    {
        "pending" => OrderStatus.Pending,
        "confirmed" => OrderStatus.Confirmed,
        "shipped" => OrderStatus.Shipped,
        "cancelled" => OrderStatus.Cancelled,
        _ => throw new ArgumentOutOfRangeException(nameof(s))
    };

    public static bool CanTransitionTo(this OrderStatus from, OrderStatus to) => (from, to) switch
    {
        (OrderStatus.Pending, OrderStatus.Confirmed) => true,
        (OrderStatus.Pending, OrderStatus.Cancelled) => true,
        (OrderStatus.Confirmed, OrderStatus.Shipped) => true,
        (OrderStatus.Confirmed, OrderStatus.Cancelled) => true,
        _ => false
    };
}

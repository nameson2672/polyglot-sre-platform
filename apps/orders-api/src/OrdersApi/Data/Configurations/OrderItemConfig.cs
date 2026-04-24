using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OrdersApi.Domain;

namespace OrdersApi.Data.Configurations;

public sealed class OrderItemConfig : IEntityTypeConfiguration<OrderItem>
{
    public void Configure(EntityTypeBuilder<OrderItem> builder)
    {
        builder.ToTable("order_items");
        builder.HasKey(i => new { i.OrderId, i.LineNo });

        builder.Property(i => i.OrderId).HasColumnName("order_id");
        builder.Property(i => i.LineNo).HasColumnName("line_no");
        builder.Property(i => i.Sku).HasColumnName("sku");
        builder.Property(i => i.Qty).HasColumnName("qty");
        builder.Property(i => i.UnitPriceCents).HasColumnName("unit_price_cents");
    }
}

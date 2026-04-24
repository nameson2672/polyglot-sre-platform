using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OrdersApi.Domain;

namespace OrdersApi.Data.Configurations;

public sealed class OrderConfig : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> builder)
    {
        builder.ToTable("orders");
        builder.HasKey(o => o.Id);

        builder.Property(o => o.Id).HasColumnName("id");
        builder.Property(o => o.CustomerId).HasColumnName("customer_id");
        builder.Property(o => o.TotalCents).HasColumnName("total_cents");
        builder.Property(o => o.Currency).HasColumnName("currency").HasMaxLength(3).IsFixedLength();
        builder.Property(o => o.CreatedAt).HasColumnName("created_at");
        builder.Property(o => o.UpdatedAt).HasColumnName("updated_at");

        builder.Property(o => o.Status)
            .HasColumnName("status")
            .HasConversion(
                v => v.ToDbString(),
                v => OrderStatusExtensions.FromDbString(v));

        builder.HasMany(o => o.Items)
            .WithOne(i => i.Order)
            .HasForeignKey(i => i.OrderId);
    }
}

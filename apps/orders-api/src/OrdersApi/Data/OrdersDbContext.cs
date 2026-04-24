using Microsoft.EntityFrameworkCore;
using OrdersApi.Data.Configurations;
using OrdersApi.Domain;
using OrdersApi.Services;

namespace OrdersApi.Data;

public sealed class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderItem> OrderItems => Set<OrderItem>();
    public DbSet<IdempotencyRecord> IdempotencyKeys => Set<IdempotencyRecord>();
    public DbSet<OutboxMessage> OutboxMessages => Set<OutboxMessage>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new OrderConfig());
        modelBuilder.ApplyConfiguration(new OrderItemConfig());
        modelBuilder.ApplyConfiguration(new IdempotencyKeyConfig());
        modelBuilder.ApplyConfiguration(new OutboxMessageConfig());
    }
}

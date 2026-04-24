using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OrdersApi.Domain;

namespace OrdersApi.Data.Configurations;

public sealed class OutboxMessageConfig : IEntityTypeConfiguration<OutboxMessage>
{
    public void Configure(EntityTypeBuilder<OutboxMessage> builder)
    {
        builder.ToTable("outbox");
        builder.HasKey(m => m.Id);

        builder.Property(m => m.Id).HasColumnName("id").UseIdentityByDefaultColumn();
        builder.Property(m => m.EventId).HasColumnName("event_id");
        builder.Property(m => m.EventType).HasColumnName("event_type");
        builder.Property(m => m.AggregateId).HasColumnName("aggregate_id");
        builder.Property(m => m.Payload).HasColumnName("payload").HasColumnType("jsonb");
        builder.Property(m => m.CreatedAt).HasColumnName("created_at");
        builder.Property(m => m.PublishedAt).HasColumnName("published_at");

        builder.HasIndex(m => m.EventId).IsUnique();
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using OrdersApi.Services;

namespace OrdersApi.Data.Configurations;

public sealed class IdempotencyKeyConfig : IEntityTypeConfiguration<IdempotencyRecord>
{
    public void Configure(EntityTypeBuilder<IdempotencyRecord> builder)
    {
        builder.ToTable("idempotency_keys");
        builder.HasKey(r => r.Key);

        builder.Property(r => r.Key).HasColumnName("key");
        builder.Property(r => r.RequestHash).HasColumnName("request_hash");
        builder.Property(r => r.ResponseBody)
            .HasColumnName("response_body")
            .HasColumnType("jsonb");
        builder.Property(r => r.ResponseCode).HasColumnName("response_code");
        builder.Property(r => r.CreatedAt).HasColumnName("created_at");
    }
}

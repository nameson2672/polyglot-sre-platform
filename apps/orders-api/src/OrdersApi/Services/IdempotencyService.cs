using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OrdersApi.Data;

namespace OrdersApi.Services;

public sealed class IdempotencyRecord
{
    public Guid Key { get; set; }
    public string RequestHash { get; set; } = string.Empty;
    public string ResponseBody { get; set; } = string.Empty;
    public int ResponseCode { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class IdempotencyService(OrdersDbContext db)
{
    public static string HashBody(string body)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(body));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public async Task<IdempotencyRecord?> FindAsync(Guid key, CancellationToken ct = default)
        => await db.IdempotencyKeys.FindAsync([key], ct);

    public async Task SaveAsync(Guid key, string requestHash, object responseBody, int statusCode, CancellationToken ct = default)
    {
        var record = new IdempotencyRecord
        {
            Key = key,
            RequestHash = requestHash,
            ResponseBody = JsonSerializer.Serialize(responseBody),
            ResponseCode = statusCode,
            CreatedAt = DateTimeOffset.UtcNow
        };
        db.IdempotencyKeys.Add(record);
        await db.SaveChangesAsync(ct);
    }
}

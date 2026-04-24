using System.ComponentModel.DataAnnotations;

namespace OrdersApi.Configuration;

public sealed class DatabaseOptions
{
    public const string Section = "Database";

    [Required]
    public string ConnectionString { get; set; } = string.Empty;
}

public sealed class RedisOptions
{
    public const string Section = "Redis";

    [Required]
    public string Url { get; set; } = string.Empty;
}

public sealed class ApiOptions
{
    public const string Section = "Api";

    [Required]
    public string ApiKey { get; set; } = string.Empty;
}

public sealed class OtelOptions
{
    public const string Section = "Otel";

    public string OtlpEndpoint { get; set; } = "http://localhost:4317";
}

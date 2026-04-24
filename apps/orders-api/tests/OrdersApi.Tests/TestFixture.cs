using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using OrdersApi.Data;
using StackExchange.Redis;
using Testcontainers.PostgreSql;
using Testcontainers.Redis;

namespace OrdersApi.Tests;

public sealed class OrdersApiFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder()
        .WithImage("postgres:16-alpine")
        .Build();

    private readonly RedisContainer _redis = new RedisBuilder()
        .WithImage("redis:7-alpine")
        .Build();

    public WebApplicationFactory<Program> Factory { get; private set; } = null!;
    public HttpClient Client { get; private set; } = null!;
    public const string ApiKey = "test-api-key";

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_postgres.StartAsync(), _redis.StartAsync());

        var pgConn = _postgres.GetConnectionString();
        var redisUrl = _redis.GetConnectionString();

        Factory = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Test");
                builder.UseSetting("Database:ConnectionString", pgConn);
                builder.UseSetting("Redis:Url", redisUrl);
                builder.UseSetting("Api:ApiKey", ApiKey);
                builder.UseSetting("POSTGRES_CONNECTION_STRING", pgConn);
                builder.UseSetting("REDIS_URL", redisUrl);
                builder.UseSetting("ORDERS_API_KEY", ApiKey);

                builder.ConfigureServices(services =>
                {
                    // Replace DbContext with test container connection
                    var descriptors = services
                        .Where(d => d.ServiceType == typeof(DbContextOptions<OrdersDbContext>))
                        .ToList();
                    foreach (var d in descriptors) services.Remove(d);

                    services.AddDbContext<OrdersDbContext>(opts =>
                        opts.UseNpgsql(pgConn));

                    // Replace Redis
                    var redisDesc = services.SingleOrDefault(d =>
                        d.ServiceType == typeof(IConnectionMultiplexer));
                    if (redisDesc != null) services.Remove(redisDesc);

                    services.AddSingleton<IConnectionMultiplexer>(
                        ConnectionMultiplexer.Connect(redisUrl));
                });
            });

        // Apply schema to test DB
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        var sqlPath = GetSchemaPath();
        var sql = await File.ReadAllTextAsync(sqlPath);
        await db.Database.ExecuteSqlRawAsync(sql);

        Client = Factory.CreateClient();
        Client.DefaultRequestHeaders.Add("X-Api-Key", ApiKey);
    }

    private static string GetSchemaPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "scripts", "init-db.sql")))
            dir = dir.Parent;
        return Path.Combine(dir?.FullName ?? ".", "scripts", "init-db.sql");
    }

    public IConnectionMultiplexer GetRedis() =>
        Factory.Services.GetRequiredService<IConnectionMultiplexer>();

    public async Task DisposeAsync()
    {
        Client.Dispose();
        await Factory.DisposeAsync();
        await _postgres.DisposeAsync();
        await _redis.DisposeAsync();
    }
}

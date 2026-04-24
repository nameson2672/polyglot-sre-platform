using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using OrdersApi.Data;

namespace OrdersApi.Tests.Endpoints;

[Collection("OrdersApi")]
public sealed class OrdersEndpointsTests(OrdersApiFixture fixture) : IClassFixture<OrdersApiFixture>
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    private static readonly object ValidOrderBody = new
    {
        customer_id = "00000000-0000-0000-0000-000000000001",
        items = new[] { new { sku = "ABC", qty = 2, unit_price_cents = 500 } },
        currency = "CAD"
    };

    // ── Health & Info ────────────────────────────────────────────────────────

    [Fact]
    public async Task Get_Healthz_Returns200()
    {
        var resp = await fixture.Client.GetAsync("/healthz");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Get_Readyz_Returns200_WhenDependenciesOk()
    {
        var resp = await fixture.Client.GetAsync("/readyz");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Get_Info_ReturnsServiceName()
    {
        var resp = await fixture.Client.GetAsync("/info");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("service").GetString().Should().Be("orders-api");
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Post_Order_Without_ApiKey_Returns401()
    {
        using var client = fixture.Factory.CreateClient();
        var resp = await PostOrderAsync(client, ValidOrderBody);
        resp.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    // ── Create Order ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Post_Order_ValidRequest_Returns201()
    {
        var resp = await PostOrderAsync(fixture.Client, ValidOrderBody);
        resp.StatusCode.Should().Be(HttpStatusCode.Created);
        resp.Headers.Location.Should().NotBeNull();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts);
        body.GetProperty("id").GetString().Should().NotBeNullOrEmpty();
        body.GetProperty("status").GetString().Should().Be("pending");
        body.GetProperty("total_cents").GetInt64().Should().Be(1000);
    }

    [Fact]
    public async Task Post_Order_Creates_OutboxRow_Atomically()
    {
        var resp = await PostOrderAsync(fixture.Client, ValidOrderBody);
        resp.StatusCode.Should().Be(HttpStatusCode.Created);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts);
        var orderId = Guid.Parse(body.GetProperty("id").GetString()!);

        using var scope = fixture.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();

        var order = await db.Orders.FindAsync(orderId);
        order.Should().NotBeNull();

        var outbox = db.OutboxMessages.FirstOrDefault(m => m.AggregateId == orderId);
        outbox.Should().NotBeNull();
        outbox!.EventType.Should().Be("order.created");
    }

    [Fact]
    public async Task Post_Order_MissingItems_Returns400()
    {
        var body = new { customer_id = Guid.NewGuid(), items = Array.Empty<object>(), currency = "CAD" };
        var resp = await PostOrderAsync(fixture.Client, body);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Post_Order_InvalidCurrency_Returns400()
    {
        var body = new { customer_id = Guid.NewGuid(), items = new[] { new { sku = "X", qty = 1, unit_price_cents = 100 } }, currency = "TOOLONG" };
        var resp = await PostOrderAsync(fixture.Client, body);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Post_Order_Missing_IdempotencyKey_Returns400()
    {
        var content = new StringContent(JsonSerializer.Serialize(ValidOrderBody), Encoding.UTF8, "application/json");
        var resp = await fixture.Client.PostAsync("/v1/orders", content);
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    // ── Idempotency ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Post_Order_SameKeyAndBody_ReturnsCachedResponse_NotDuplicate()
    {
        var key = Guid.NewGuid().ToString();

        var resp1 = await PostOrderAsync(fixture.Client, ValidOrderBody, key);
        resp1.StatusCode.Should().Be(HttpStatusCode.Created);
        var id1 = (await resp1.Content.ReadFromJsonAsync<JsonElement>(JsonOpts)).GetProperty("id").GetString();

        var resp2 = await PostOrderAsync(fixture.Client, ValidOrderBody, key);
        resp2.StatusCode.Should().Be(HttpStatusCode.Created);
        var id2 = (await resp2.Content.ReadFromJsonAsync<JsonElement>(JsonOpts)).GetProperty("id").GetString();

        id1.Should().Be(id2, "idempotency should return same order");

        using var scope = fixture.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Count(o => o.Id.ToString() == id1).Should().Be(1, "no duplicate order created");
    }

    [Fact]
    public async Task Post_Order_SameKey_DifferentBody_Returns409()
    {
        var key = Guid.NewGuid().ToString();

        var resp1 = await PostOrderAsync(fixture.Client, ValidOrderBody, key);
        resp1.StatusCode.Should().Be(HttpStatusCode.Created);

        var different = new
        {
            customer_id = "00000000-0000-0000-0000-000000000002",
            items = new[] { new { sku = "XYZ", qty = 1, unit_price_cents = 9999 } },
            currency = "USD"
        };
        var resp2 = await PostOrderAsync(fixture.Client, different, key);
        resp2.StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    // ── Get Order ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Get_Order_ValidId_Returns200()
    {
        var created = await CreateOrderAsync();
        var id = created.GetProperty("id").GetString();

        var resp = await fixture.Client.GetAsync($"/v1/orders/{id}");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts))
            .GetProperty("id").GetString().Should().Be(id);
    }

    [Fact]
    public async Task Get_Order_InvalidUuid_Returns400_Not500()
    {
        var resp = await fixture.Client.GetAsync("/v1/orders/not-a-uuid");
        resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Get_Order_NonExistent_Returns404()
    {
        var resp = await fixture.Client.GetAsync($"/v1/orders/{Guid.NewGuid()}");
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ── List Orders ──────────────────────────────────────────────────────────

    [Fact]
    public async Task Get_Orders_Returns200_WithPagination()
    {
        await CreateOrderAsync();

        var resp = await fixture.Client.GetAsync("/v1/orders?page=1&page_size=10");
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts);
        body.GetProperty("items").GetArrayLength().Should().BeGreaterThan(0);
        body.GetProperty("total").GetInt32().Should().BeGreaterThan(0);
    }

    // ── Status Transitions ───────────────────────────────────────────────────

    [Fact]
    public async Task Patch_Order_ValidTransition_Pending_To_Confirmed_Returns200()
    {
        var created = await CreateOrderAsync();
        var id = created.GetProperty("id").GetString();

        var resp = await fixture.Client.PatchAsync($"/v1/orders/{id}",
            JsonContent(new { status = "confirmed" }));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);

        (await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts))
            .GetProperty("status").GetString().Should().Be("confirmed");
    }

    [Fact]
    public async Task Patch_Order_InvalidTransition_Pending_To_Shipped_Returns422()
    {
        var created = await CreateOrderAsync();
        var id = created.GetProperty("id").GetString();

        var resp = await fixture.Client.PatchAsync($"/v1/orders/{id}",
            JsonContent(new { status = "shipped" }));
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Patch_Order_Confirmed_To_Shipped_Returns200()
    {
        var created = await CreateOrderAsync();
        var id = created.GetProperty("id").GetString();

        await fixture.Client.PatchAsync($"/v1/orders/{id}", JsonContent(new { status = "confirmed" }));

        var resp = await fixture.Client.PatchAsync($"/v1/orders/{id}", JsonContent(new { status = "shipped" }));
        resp.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // ── Cancel ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task Delete_Order_Returns204()
    {
        var created = await CreateOrderAsync();
        var id = created.GetProperty("id").GetString();

        var resp = await fixture.Client.DeleteAsync($"/v1/orders/{id}");
        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Delete_Order_NonExistent_Returns404()
    {
        var resp = await fixture.Client.DeleteAsync($"/v1/orders/{Guid.NewGuid()}");
        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    // ── Slow / Chaos ─────────────────────────────────────────────────────────

    [Fact]
    public async Task Get_Slow_TakesAtLeast2Seconds()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var resp = await fixture.Client.GetAsync("/v1/orders/slow", cts.Token);
        sw.Stop();

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        sw.ElapsedMilliseconds.Should().BeGreaterThanOrEqualTo(1900);
    }

    // ── Outbox Publisher ─────────────────────────────────────────────────────

    [Fact]
    public async Task OutboxPublisher_PublishesToRedisStream()
    {
        await CreateOrderAsync();

        // Give the background publisher up to 5 seconds to publish
        await Task.Delay(5000);

        var redis = fixture.GetRedis();
        var db = redis.GetDatabase();
        var entries = await db.StreamRangeAsync("orders.events", "-", "+", count: 1);

        entries.Should().NotBeEmpty("outbox publisher should have written to Redis stream");
        entries[0]["event_type"].ToString().Should().Be("order.created");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task<JsonElement> CreateOrderAsync()
    {
        var resp = await PostOrderAsync(fixture.Client, ValidOrderBody);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>(JsonOpts);
    }

    private static Task<HttpResponseMessage> PostOrderAsync(
        HttpClient client, object body, string? idempotencyKey = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/v1/orders")
        {
            Content = JsonContent(body)
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey ?? Guid.NewGuid().ToString());
        return client.SendAsync(request);
    }

    private static StringContent JsonContent(object body) =>
        new(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
}

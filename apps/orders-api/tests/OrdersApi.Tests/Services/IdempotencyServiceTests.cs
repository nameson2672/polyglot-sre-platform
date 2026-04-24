using OrdersApi.Services;

namespace OrdersApi.Tests.Services;

public sealed class IdempotencyServiceTests
{
    [Fact]
    public void HashBody_SameInput_ReturnsSameHash()
    {
        var hash1 = IdempotencyService.HashBody("{\"foo\":\"bar\"}");
        var hash2 = IdempotencyService.HashBody("{\"foo\":\"bar\"}");
        hash1.Should().Be(hash2);
    }

    [Fact]
    public void HashBody_DifferentInput_ReturnsDifferentHash()
    {
        var hash1 = IdempotencyService.HashBody("{\"foo\":\"bar\"}");
        var hash2 = IdempotencyService.HashBody("{\"foo\":\"baz\"}");
        hash1.Should().NotBe(hash2);
    }

    [Fact]
    public void HashBody_ReturnsLowercaseHex()
    {
        var hash = IdempotencyService.HashBody("test");
        hash.Should().MatchRegex("^[0-9a-f]{64}$");
    }

    [Fact]
    public void HashBody_EmptyString_DoesNotThrow()
    {
        var act = () => IdempotencyService.HashBody(string.Empty);
        act.Should().NotThrow();
    }
}

using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.KitchenSink.Client;

namespace RefitClient.Tests;

/// <summary>
/// Unions and literal types travel as what is actually on the wire, once for each way a client is built.
/// </summary>
public abstract class UnionTests
{
    /// <summary>The smallest <c>Nested</c> response, before the union properties are filled in.</summary>
    private const string NestedTemplate =
        """{"grid":[],"byName":{},"lists":{},"maybe":MAYBE,"either":EITHER,"oneOf":"c","level":1,"scalars":null,"page":null,"pageOfText":null}""";

    /// <summary>Gets how the client under test is built.</summary>
    protected abstract Wiring Wiring { get; }

    private (KitchenSinkClient Client, StubHandler Handler) Create() => Harness.KitchenSink(Wiring);

    private static string Nested(string maybe, string either) =>
        NestedTemplate.Replace("MAYBE", maybe).Replace("EITHER", either);

    [TestMethod]
    public async Task A_union_of_a_string_and_a_number_reads_either()
    {
        var (client, handler) = Create();
        handler.RespondJson(Nested("null", "7"));
        handler.RespondJson(Nested("null", "\"seven\""));

        var number = await client.Misc.NestedAsync();
        var text = await client.Misc.NestedAsync();

        number.Either.ValueKind.Should().Be(JsonValueKind.Number);
        number.Either.GetInt32().Should().Be(7);
        text.Either.ValueKind.Should().Be(JsonValueKind.String);
        text.Either.GetString().Should().Be("seven");
    }

    [TestMethod]
    public async Task A_nullable_union_is_null_or_the_value()
    {
        var (client, handler) = Create();
        handler.RespondJson(Nested("null", "1"));
        handler.RespondJson(Nested("\"n\"", "1"));

        var empty = await client.Misc.NestedAsync();
        var full = await client.Misc.NestedAsync();

        empty.Maybe.Should().BeNull();
        full.Maybe.Should().Be("n");
    }

    [TestMethod]
    public async Task A_union_of_two_models_can_be_read_as_either()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"gear","note":"n"}""");

        var either = await client.Misc.EitherAsync();

        either.Deserialize<Special>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Note.Should().Be("n");
        either.Deserialize<Derived>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!.Name.Should().Be("gear");
    }

    [TestMethod]
    public async Task A_union_is_sent_as_the_json_it_holds_by_the_client_serializer()
    {
        // Nested is only a response, so the body the Refit settings would write is checked directly.
        var serializer = KitchenSinkClient.CreateRefitSettings().ContentSerializer;

        var json = await serializer.ToHttpContent(new Nested
        {
            Either = JsonSerializer.SerializeToElement(42),
            Maybe = null,
            OneOf = "a",
        }).ReadAsStringAsync();

        using var sent = JsonDocument.Parse(json);
        sent.RootElement.GetProperty("either").ValueKind.Should().Be(JsonValueKind.Number);
        sent.RootElement.GetProperty("maybe").ValueKind.Should()
            .Be(JsonValueKind.Null, "maybe is required, so a null is sent as null rather than left out");
        sent.RootElement.TryGetProperty("color", out _).Should().BeFalse("color is optional, so a null is left out");
    }

    [TestMethod]
    public async Task A_required_nullable_property_that_is_set_is_sent_as_its_value()
    {
        var serializer = KitchenSinkClient.CreateRefitSettings().ContentSerializer;

        var json = await serializer.ToHttpContent(new Nested { Either = JsonSerializer.SerializeToElement("x"), Maybe = "hello" })
            .ReadAsStringAsync();

        using var sent = JsonDocument.Parse(json);
        sent.RootElement.GetProperty("maybe").GetString().Should().Be("hello");
        sent.RootElement.GetProperty("either").GetString().Should().Be("x");
    }

    [TestMethod]
    public void A_literal_union_is_its_underlying_type()
    {
        typeof(Nested).GetProperty("OneOf")!.PropertyType.Should().Be(typeof(string));
    }
}

/// <summary>The union tests, through <c>KitchenSinkClient.Create</c>.</summary>
[TestClass]
public sealed class UnionThroughCreateTests : UnionTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.Create;
}

/// <summary>The union tests, through <c>AddKitchenSinkClient</c>.</summary>
[TestClass]
public sealed class UnionThroughDependencyInjectionTests : UnionTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.DependencyInjection;
}

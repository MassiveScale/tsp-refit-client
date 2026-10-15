using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.KitchenSink.Client;
using MassiveScale.Simple.Api.Example.Client;
using V1 = MassiveScale.AllVersions.Client.V1_0;

namespace RefitClient.Tests;

/// <summary>
/// Enums travel on the wire as their declared values, not their C# member names, once for each
/// way a client is built.
/// </summary>
public abstract class EnumWireValueTests
{
    /// <summary>Gets how the client under test is built.</summary>
    protected abstract Wiring Wiring { get; }

    [TestMethod]
    public async Task An_enum_in_a_request_body_is_sent_as_its_declared_value()
    {
        var (client, handler) = Harness.Simple(Wiring);
        handler.RespondJson("""{"id":"1","weight":2,"color":"blue"}""");

        await client.Widgets.CreateAsync(new Widget { Id = "1", Weight = 2, Color = WidgetColor.Blue });

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("color").GetString().Should().Be("blue");
    }

    [TestMethod]
    public async Task An_enum_in_a_response_is_read_from_its_declared_value()
    {
        var (client, handler) = Harness.Simple(Wiring);
        handler.RespondJson("""{"id":"1","weight":2,"color":"red"}""");

        var widget = await client.Widgets.ReadAsync("1");

        widget.Color.Should().Be(WidgetColor.Red);
    }

    [TestMethod]
    public async Task An_unknown_enum_value_is_rejected_rather_than_guessed()
    {
        var (client, handler) = Harness.Simple(Wiring);
        handler.RespondJson("""{"id":"1","weight":2,"color":"purple"}""");

        var act = () => client.Widgets.ReadAsync("1");

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("purple");
    }

    [TestMethod]
    public async Task A_non_string_enum_value_is_rejected()
    {
        var (client, handler) = Harness.Simple(Wiring);
        handler.RespondJson("""{"id":"1","weight":2,"color":3}""");

        var act = () => client.Widgets.ReadAsync("1");

        await act.Should().ThrowAsync<Exception>();
    }

    [TestMethod]
    public async Task An_omitted_optional_enum_is_left_out_and_reads_back_as_null()
    {
        var (client, handler) = Harness.AllVersionsV1(Wiring);
        handler.RespondJson("""{"id":"1","name":"gear"}""").RespondJson("""{"id":"1","name":"gear"}""");

        await client.Widgets.CreateAsync(new V1.WidgetCreateRequest { Name = "gear" });
        var widget = await client.Widgets.ReadAsync("1");

        handler.Requests[0].Body.Should().Be("""{"name":"gear"}""");
        widget.Status.Should().BeNull();
    }

    [TestMethod]
    public async Task A_numeric_enum_is_read_from_a_json_number()
    {
        var (client, handler) = Harness.KitchenSink(Wiring);
        handler.RespondJson("1").RespondJson("0.5");

        (await client.Misc.MagnitudeAsync()).Should().Be(Magnitude.One);
        (await client.Misc.MagnitudeAsync()).Should().Be(Magnitude.Tiny);
    }

    [TestMethod]
    public async Task An_unknown_number_is_rejected_for_a_numeric_enum()
    {
        var (client, handler) = Harness.KitchenSink(Wiring);
        handler.RespondJson("7");

        var act = () => client.Misc.MagnitudeAsync();

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("7");
    }

    [TestMethod]
    public async Task A_string_is_rejected_for_a_numeric_only_enum()
    {
        var (client, handler) = Harness.KitchenSink(Wiring);
        handler.RespondJson("\"one\"");

        var act = () => client.Misc.MagnitudeAsync();

        (await act.Should().ThrowAsync<Exception>()).Which.ToString().Should().Contain("a number");
    }

    [TestMethod]
    public async Task A_numeric_enum_is_sent_as_a_json_number_by_the_client_serializer()
    {
        // No kitchen-sink request carries a numeric enum, so the body the Refit settings write is checked directly.
        var content = KitchenSinkClient.CreateRefitSettings().ContentSerializer.ToHttpContent(Magnitude.Tiny);

        (await content.ReadAsStringAsync()).Should().Be("0.5");
    }

    [TestMethod]
    public async Task A_mixed_enum_is_written_and_read_as_a_string_or_a_number_by_member()
    {
        var serializer = KitchenSinkClient.CreateRefitSettings().ContentSerializer;

        (await serializer.ToHttpContent(Level.High).ReadAsStringAsync()).Should().Be("2");
        (await serializer.ToHttpContent(Level.Mixed).ReadAsStringAsync()).Should().Be("\"mixed\"");

        var (client, handler) = Harness.KitchenSink(Wiring);
        handler.RespondJson(NestedWithLevel("2")).RespondJson(NestedWithLevel("\"mixed\""));
        (await client.Misc.NestedAsync()).Level.Should().Be(Level.High);
        (await client.Misc.NestedAsync()).Level.Should().Be(Level.Mixed);
    }

    /// <summary>The smallest <c>Nested</c> response, with a given <c>level</c>.</summary>
    private static string NestedWithLevel(string level) =>
        $$"""{"grid":[],"byName":{},"lists":{},"maybe":null,"either":1,"oneOf":"a","level":{{level}},"scalars":null,"page":null,"pageOfText":null}""";
}

/// <summary>The enum tests, through each client's <c>Create</c>.</summary>
[TestClass]
public sealed class EnumWireValueThroughCreateTests : EnumWireValueTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.Create;
}

/// <summary>The enum tests, through each client's registration method.</summary>
[TestClass]
public sealed class EnumWireValueThroughDependencyInjectionTests : EnumWireValueTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.DependencyInjection;
}

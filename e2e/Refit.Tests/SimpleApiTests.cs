using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.Simple.Api.Example.Client;
using Refit;

namespace RefitClient.Tests;

/// <summary>
/// Reading and sending the simple-api example's models, the shape most clients have: a CRUD
/// interface whose operations return a model or a typed error. Once for each way a client is built.
/// </summary>
public abstract class SimpleApiTests
{
    private const string WidgetJson = """{"id":"1","weight":3,"color":"red","sku":"S-1"}""";

    /// <summary>Gets how the client under test is built.</summary>
    protected abstract Wiring Wiring { get; }

    private (ExampleClient Client, StubHandler Handler) Create() => Harness.Simple(Wiring);

    [TestMethod]
    public async Task A_response_is_read_as_the_generated_model_and_unknown_properties_are_dropped()
    {
        var (client, handler) = Create();
        handler.RespondJson(WidgetJson);

        var widget = await client.Widgets.ReadAsync("1");

        widget.Should().BeOfType<Widget>();
        widget.Weight.Should().Be(3);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/widgets/1");
    }

    [TestMethod]
    public async Task A_wrapper_with_a_list_of_models_is_read()
    {
        var (client, handler) = Create();
        handler.RespondJson($$"""{"items":[{{WidgetJson}}]}""");

        var list = await client.Widgets.ListAsync();

        list.Items.Should().ContainSingle().Which.Color.Should().Be(WidgetColor.Red);
    }

    [TestMethod]
    public async Task A_model_is_sent_as_json()
    {
        var (client, handler) = Create();
        handler.RespondJson(WidgetJson);

        await client.Widgets.CreateAsync(new Widget { Id = "1", Weight = 3, Color = WidgetColor.Blue });

        handler.Last.Method.Should().Be(HttpMethod.Post);
        handler.Last.ContentType.Should().StartWith("application/json");
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("weight").GetInt32().Should().Be(3);
        sent.RootElement.GetProperty("color").GetString().Should().Be("blue");
    }

    [TestMethod]
    public async Task A_post_without_a_body_sends_no_content()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","analysis":"fine"}""");

        var result = await client.Widgets.AnalyzeAsync("1");

        handler.Last.Method.Should().Be(HttpMethod.Post);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/widgets/1/analyze");
        handler.Last.Body.Should().BeNullOrEmpty();
        result.Analysis.Should().Be("fine");
    }

    [TestMethod]
    public async Task A_non_success_response_throws_and_exposes_the_typed_error_body()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"code":7,"message":"nope"}""", System.Net.HttpStatusCode.BadRequest);

        var act = () => client.Widgets.ReadAsync("1");

        var failure = (await act.Should().ThrowAsync<ApiException>()).Which;
        failure.Content.Should().Contain("nope");
        var error = await failure.GetContentAsAsync<Error>();
        error!.Code.Should().Be(7);
    }

    [TestMethod]
    public async Task A_merge_patch_sends_only_what_was_set_and_null_for_what_was_cleared()
    {
        var (client, handler) = Create();
        handler.RespondJson(WidgetJson);

        var patch = new MergePatch<Widget>().Set(w => w.Weight, 5).Clear(w => w.Color);
        await client.Widgets.UpdateAsync("1", patch);

        handler.Last.Method.Should().Be(HttpMethod.Patch);
        handler.Last.ContentType.Should().StartWith("application/merge-patch+json");
        handler.Last.Body.Should().Be("""{"weight":5,"color":null}""");
    }

    [TestMethod]
    public async Task A_null_set_on_a_merge_patch_is_sent_as_json_null()
    {
        var (client, handler) = Create();
        handler.RespondJson(WidgetJson);

        await client.Widgets.UpdateAsync("1", new MergePatch<Widget>().Set("color", (object?)null));

        handler.Last.Body.Should().Be("""{"color":null}""");
    }

    [TestMethod]
    public async Task An_enum_set_on_a_merge_patch_is_sent_as_its_declared_value()
    {
        var (client, handler) = Create();
        handler.RespondJson(WidgetJson);

        await client.Widgets.UpdateAsync("1", new MergePatch<Widget>().Set(w => w.Color, WidgetColor.Blue));

        handler.Last.Body.Should().Be("""{"color":"blue"}""");
    }

    [TestMethod]
    public async Task A_delete_completes_without_a_body()
    {
        var (client, handler) = Create();

        await client.Widgets.DeleteAsync("1");

        handler.Last.Method.Should().Be(HttpMethod.Delete);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/widgets/1");
    }
}

/// <summary>The simple-api tests, through <c>ExampleClient.Create</c>.</summary>
[TestClass]
public sealed class SimpleApiThroughCreateTests : SimpleApiTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.Create;
}

/// <summary>The simple-api tests, through <c>AddExampleClient</c>.</summary>
[TestClass]
public sealed class SimpleApiThroughDependencyInjectionTests : SimpleApiTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.DependencyInjection;
}

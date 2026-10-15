using System.Text.Json;
using AwesomeAssertions;
using MassiveScale.KitchenSink.Client;
using Microsoft.Extensions.DependencyInjection;
using Refit;

namespace RefitClient.Tests;

/// <summary>
/// Routes, parameters, headers, and raw bodies, checked once for each way a client is built
/// (see <see cref="Wiring"/>), since the two put the generated wire handler in the chain differently.
/// </summary>
public abstract class WireFormatTests
{
    /// <summary>Gets how the client under test is built.</summary>
    protected abstract Wiring Wiring { get; }

    private (KitchenSinkClient Client, StubHandler Handler) Create() => Harness.KitchenSink(Wiring);

    [TestMethod]
    public async Task Query_parameters_use_wire_names_and_join_unexploded_lists()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems.ListAsync(limit: 5, color: Color.Blue, tags: ["a", "b"], trace: "trace-1");

        handler.Last.Method.Should().Be(HttpMethod.Get);
        // TypeSpec arrays are not exploded by default, so a list is one comma-separated value.
        Uri.UnescapeDataString(handler.Last.Uri.PathAndQuery).Should().Be("/api/derived?limit=5&color=blue&tags=a,b");
        handler.Last.Headers["X-Trace"].Should().Be("trace-1");
    }

    [TestMethod]
    public async Task Omitted_optional_parameters_add_nothing()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems.ListAsync();

        handler.Last.Uri.PathAndQuery.Should().Be("/api/derived");
        handler.Last.Headers.Should().NotContainKey("X-Trace");
    }

    [TestMethod]
    public async Task Additional_query_parameters_are_appended_in_their_wire_format()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"items":[]}""");

        await client.DerivedItems.ListAsync(additionalQueryParameters: new() { ["debug"] = true, ["when"] = Color.Dark_green });

        handler.Last.Uri.Query.Should().Be("?debug=true&when=dark-green");
    }

    [TestMethod]
    public async Task Path_values_are_fully_percent_encoded()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"x","name":"n"}""");

        await client.DerivedItems.ReadAsync("a/b c?d");

        handler.Last.Uri.AbsolutePath.Should().Be("/api/derived/a%2Fb%20c%3Fd");
    }

    [TestMethod]
    public async Task A_delete_with_no_response_body_completes()
    {
        var (client, handler) = Create();

        await client.DerivedItems.RemoveAsync("1");

        handler.Last.Method.Should().Be(HttpMethod.Delete);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/derived/1");
    }

    [TestMethod]
    public async Task A_json_body_is_sent_as_json_with_its_wire_names()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"n"}""", System.Net.HttpStatusCode.Created);

        var created = await client.DerivedItems.CreateAsync(new Derived { Id = "1", Name = "n" });

        handler.Last.Method.Should().Be(HttpMethod.Post);
        handler.Last.ContentType.Should().StartWith("application/json");
        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.GetProperty("id").GetString().Should().Be("1");
        sent.RootElement.GetProperty("name").GetString().Should().Be("n");
        created.Name.Should().Be("n");
    }

    [TestMethod]
    public async Task A_list_body_is_sent_as_a_json_array()
    {
        var (client, handler) = Create();
        handler.RespondJson("""[{"id":"1","name":"a"}]""");

        var created = await client.DerivedItems.CreateManyAsync([new Derived { Id = "1", Name = "a" }]);

        using var sent = JsonDocument.Parse(handler.Last.Body!);
        sent.RootElement.ValueKind.Should().Be(JsonValueKind.Array);
        sent.RootElement[0].GetProperty("name").GetString().Should().Be("a");
        created.Should().ContainSingle().Which.Name.Should().Be("a");
    }

    [TestMethod]
    public async Task A_merge_patch_is_sent_with_its_media_type_and_only_the_values_set()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"id":"1","name":"renamed"}""");

        await client.DerivedItems.UpdateAsync("1", new MergePatch<Derived>().Set(d => d.Name, "renamed").Clear("extra"));

        handler.Last.Method.Should().Be(HttpMethod.Patch);
        handler.Last.ContentType.Should().StartWith("application/merge-patch+json");
        handler.Last.Body.Should().Be("""{"name":"renamed","extra":null}""");
    }

    [TestMethod]
    public async Task A_byte_body_is_sent_raw_with_its_media_type()
    {
        var (client, handler) = Create();
        byte[] payload = [1, 2, 3, 255];

        await client.Files.UploadAsync(payload);

        handler.Last.BodyBytes.Should().Equal(payload);
        handler.Last.ContentType.Should().Be("application/octet-stream");
    }

    [TestMethod]
    public async Task A_byte_response_is_returned_raw()
    {
        var (client, handler) = Create();
        byte[] payload = [9, 8, 7, 0, 255];
        handler.RespondBytes(payload);

        var data = await client.Files.DownloadAsync("f1");

        data.Should().Equal(payload);
        handler.Last.Uri.AbsolutePath.Should().Be("/api/files/f1");
    }

    [TestMethod]
    public async Task A_text_body_is_sent_as_utf8_text_plain()
    {
        var (client, handler) = Create();

        await client.Files.NoteAsync("café");

        handler.Last.Body.Should().Be("café");
        handler.Last.ContentType.Should().Be("text/plain; charset=utf-8");
    }

    [TestMethod]
    public async Task A_string_response_declared_as_json_is_read_without_its_quotes()
    {
        var (client, handler) = Create();
        handler.RespondJson("\"pong\"");

        (await client.Pings.PingAsync()).Should().Be("pong");
    }

    [TestMethod]
    public async Task A_non_success_status_throws_with_the_status_and_the_body()
    {
        var (client, handler) = Create();
        handler.RespondJson("""{"code":7,"message":"nope"}""", System.Net.HttpStatusCode.NotFound);

        var act = () => client.DerivedItems.ReadAsync("1");

        var failure = (await act.Should().ThrowAsync<ApiException>()).Which;
        failure.StatusCode.Should().Be(System.Net.HttpStatusCode.NotFound);
        failure.Content.Should().Contain("nope");
    }

    [TestMethod]
    public async Task A_cancelled_token_stops_the_call()
    {
        var (client, _) = Create();
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        var act = () => client.DerivedItems.ReadAsync("1", cancellationToken: cancelled.Token);

        // Refit 11 wraps a failed send, cancellation included, in an ApiRequestException.
        var thrown = (await act.Should().ThrowAsync<Exception>()).Which;
        Harness.Find<OperationCanceledException>(thrown).Should().NotBeNull("{0}", thrown);
    }
}

/// <summary>The wire-format tests, through <c>KitchenSinkClient.Create</c>.</summary>
[TestClass]
public sealed class WireFormatThroughCreateTests : WireFormatTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.Create;
}

/// <summary>The wire-format tests, through <c>AddKitchenSinkClient</c>.</summary>
[TestClass]
public sealed class WireFormatThroughDependencyInjectionTests : WireFormatTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.DependencyInjection;
}

/// <summary>The generated registration method, aggregate client, and <c>Create</c>.</summary>
[TestClass]
public sealed class ClientConstructionTests
{
    [TestMethod]
    public async Task Calls_made_through_dependency_injection_reach_the_configured_handler()
    {
        var handler = new StubHandler().RespondJson("""{"id":"1","name":"gear"}""");
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler));
        await using var provider = services.BuildServiceProvider();

        var derived = await provider.GetRequiredService<IDerivedItems>().ReadAsync("1");
        var aggregate = provider.GetRequiredService<KitchenSinkClient>();

        derived.Name.Should().Be("gear");
        aggregate.Vehicles.Should().NotBeNull();
        aggregate.DerivedItems.Should().NotBeNull();
        aggregate.Animals.Should().NotBeNull();
        aggregate.Files.Should().NotBeNull();
        aggregate.Misc.Should().NotBeNull();
        aggregate.Text.Should().NotBeNull();
        aggregate.Encodings.Should().NotBeNull();
        aggregate.Pings.Should().NotBeNull();
        handler.Last.Uri.Host.Should().Be("api.test");
    }

    [TestMethod]
    public async Task A_handler_added_through_the_builder_sees_the_headers_the_wire_handler_wrote()
    {
        var handler = new StubHandler().RespondJson("""{"items":[]}""");
        var recorder = new HeaderRecorder();
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = new Uri("https://api.test/"),
            builder => builder.AddHttpMessageHandler(() => recorder).ConfigurePrimaryHttpMessageHandler(() => handler));
        await using var provider = services.BuildServiceProvider();

        await provider.GetRequiredService<IDerivedItems>().ListAsync(trace: "t-1");

        recorder.Seen.Should().ContainSingle().Which["X-Trace"].Should().Be("t-1");
    }

    [TestMethod]
    public void An_internal_interface_is_an_internal_property_of_the_aggregate_client()
    {
        var property = typeof(KitchenSinkClient).GetProperty(
            "Admin", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

        property.Should().NotBeNull();
        typeof(KitchenSinkClient).GetProperty("Admin").Should().BeNull("an @access(Access.internal) interface is not public");
        typeof(KitchenSinkClient).GetConstructors().Should().BeEmpty("the constructor takes the internal interface, so it is internal too");
    }

    [TestMethod]
    public void A_client_can_be_created_from_a_base_address()
    {
        var client = KitchenSinkClient.Create(new Uri("https://api.test"));

        client.DerivedItems.Should().NotBeNull();
        client.Files.Should().NotBeNull();
    }

    [TestMethod]
    public async Task A_client_created_without_dependency_injection_sends_through_the_inner_handler()
    {
        var handler = new StubHandler().RespondJson("""{"id":"1","name":"gear"}""");
        var client = KitchenSinkClient.Create(new Uri("https://api.test/root/"), handler);

        await client.DerivedItems.ReadAsync("1");

        handler.Last.Uri.ToString().Should().Be("https://api.test/root/api/derived/1");
    }

    [TestMethod]
    public void Create_requires_a_base_address()
    {
        var act = () => KitchenSinkClient.Create(null!);

        act.Should().Throw<ArgumentNullException>().WithParameterName("baseAddress");
    }

    [TestMethod]
    public void Registration_requires_its_arguments()
    {
        new ServiceCollection().Invoking(s => s.AddKitchenSinkClient(null!)).Should().Throw<ArgumentNullException>();

        var act = () => KitchenSinkClientExtensions.AddKitchenSinkClient(null!, _ => { });
        act.Should().Throw<ArgumentNullException>();
    }

    [TestMethod]
    public async Task An_interface_created_with_the_generated_settings_and_handler_sends_the_wire_format()
    {
        var handler = new StubHandler().RespondJson("""{"items":[]}""");
        var http = new HttpClient(KitchenSinkClient.CreateHttpMessageHandler(handler)) { BaseAddress = new Uri("https://api.test/") };
        var items = RestService.For<IDerivedItems>(http, KitchenSinkClient.CreateRefitSettings());

        await items.ListAsync(color: Color.Dark_green, trace: "t-1");

        Uri.UnescapeDataString(handler.Last.Uri.Query).Should().Be("?color=dark-green");
        handler.Last.Headers["X-Trace"].Should().Be("t-1");
    }

    [TestMethod]
    public void Each_call_creates_new_settings_and_a_new_handler()
    {
        KitchenSinkClient.CreateRefitSettings().Should().NotBeSameAs(KitchenSinkClient.CreateRefitSettings());
        KitchenSinkClient.CreateHttpMessageHandler().Should().NotBeSameAs(KitchenSinkClient.CreateHttpMessageHandler());
        KitchenSinkClient.CreateHttpMessageHandler().InnerHandler.Should().BeNull("a builder sets the inner handler itself");
    }
}

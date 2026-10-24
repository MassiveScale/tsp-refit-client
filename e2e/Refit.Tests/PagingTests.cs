using AwesomeAssertions;
using MassiveScale.KitchenSink.Client;
using Microsoft.Extensions.DependencyInjection;

namespace RefitClient.Tests;

/// <summary>
/// The paging wrappers of the kitchen-sink <c>Shelves</c> interface, driven against the stub
/// network: every page is fetched, the loop ends where it should, and cancellation stops it.
/// The strategies that call back through the Refit interface run once for each way a client is built.
/// </summary>
public abstract class PagingTests
{
    /// <summary>Gets how the client under test is built.</summary>
    protected abstract Wiring Wiring { get; }

    private (KitchenSinkClient Client, StubHandler Handler) Create() => Harness.KitchenSink(Wiring);

    [TestMethod]
    public async Task A_continuation_token_is_sent_back_until_the_server_stops_returning_one()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"items":[{"name":"a"}],"nextToken":"t2"}""")
            .RespondJson("""{"items":[{"name":"b"}]}""");

        var shelves = await Paging.All(client.Shelves.TokensAllAsync());

        shelves.Select(s => s.Name).Should().Equal("a", "b");
        handler.Requests.Should().HaveCount(2);
        handler.Requests[0].Uri.Query.Should().NotContain("token=");
        handler.Requests[1].Uri.Query.Should().Contain("token=t2");
    }

    [TestMethod]
    public async Task An_offset_advances_by_the_items_received_and_stops_on_an_empty_page()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"items":[{"name":"a"},{"name":"b"}]}""")
            .RespondJson("""{"items":[{"name":"c"}]}""")
            .RespondJson("""{"items":[]}""");

        var shelves = await Paging.All(client.Shelves.OffsetsAllAsync(size: 2));

        shelves.Select(s => s.Name).Should().Equal("a", "b", "c");
        handler.Requests.Select(r => r.Uri.Query).Should().SatisfyRespectively(
            q => q.Should().Contain("offset=0"),
            q => q.Should().Contain("offset=2"),
            q => q.Should().Contain("offset=3"));
    }

    [TestMethod]
    public async Task A_page_index_starts_at_its_declared_default_and_advances_by_one()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"items":[{"name":"a"}]}""")
            .RespondJson("""{"items":[{"name":"b"}]}""")
            .RespondJson("""{"items":[]}""");

        var shelves = await Paging.All(client.Shelves.IndexesAllAsync());

        shelves.Select(s => s.Name).Should().Equal("a", "b");
        handler.Requests.Select(r => r.Uri.Query).Should().SatisfyRespectively(
            q => q.Should().Contain("page=1"),
            q => q.Should().Contain("page=2"),
            q => q.Should().Contain("page=3"));
    }

    [TestMethod]
    public async Task A_counter_too_narrow_for_the_next_position_throws_instead_of_wrapping_around()
    {
        var (client, handler) = Create();
        var tenItems = string.Join(",", Enumerable.Repeat("{\"name\":\"x\"}", 10));
        handler.RespondJson("{\"items\":[" + tenItems + "]}");

        // A uint8 offset of 250 plus ten items would be 260, which a byte cannot hold.
        var act = async () => await Paging.All(client.SmallShelves.ListAllAsync(offset: 250));

        await act.Should().ThrowAsync<OverflowException>();
        handler.Requests.Should().ContainSingle();
    }

    [TestMethod]
    public async Task A_declared_bodyless_success_ends_the_enumeration_without_items()
    {
        var (client, handler) = Create();

        // With nothing queued the stub answers 204 No Content, the operation's `void` success.
        var shelves = await Paging.All(client.Shelves.MaybeAllAsync());

        shelves.Should().BeEmpty();
        handler.Requests.Should().ContainSingle();
    }

    [TestMethod]
    public async Task Cancelling_between_items_stops_before_the_next_page_is_requested()
    {
        var (client, handler) = Create();
        handler
            .RespondJson("""{"items":[{"name":"a"},{"name":"b"}],"nextToken":"t2"}""")
            .RespondJson("""{"items":[{"name":"c"}]}""");
        using var cancellation = new CancellationTokenSource();

        var act = async () =>
        {
            await foreach (var _ in client.Shelves.TokensAllAsync(cancellationToken: cancellation.Token))
            {
                cancellation.Cancel();
            }
        };

        await act.Should().ThrowAsync<OperationCanceledException>();
        handler.Requests.Should().ContainSingle();
    }
}

[TestClass]
public sealed class PagingThroughCreateTests : PagingTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.Create;
}

[TestClass]
public sealed class PagingThroughDependencyInjectionTests : PagingTests
{
    /// <inheritdoc />
    protected override Wiring Wiring => Wiring.DependencyInjection;
}

/// <summary>
/// The next-link wrappers, which follow each link through the interface's own named
/// <see cref="HttpClient"/> and so are only available from a container.
/// </summary>
[TestClass]
public sealed class NextLinkPagingTests
{
    private static readonly DateTimeOffset Since = new(2024, 1, 2, 3, 4, 5, TimeSpan.Zero);

    [TestMethod]
    public async Task Absolute_and_relative_next_links_are_followed_and_read_as_pages()
    {
        var (client, factory, handler) = Paging.Container();
        handler
            .RespondJson("""{"items":[{"name":"a"}],"next":"https://api.test/shelves/links?cursor=2"}""")
            .RespondJson("""{"items":[{"name":"b"}],"next":"/shelves/links?cursor=3"}""")
            .RespondJson("""{"items":[{"name":"c"}]}""");

        var shelves = await Paging.All(client.Shelves.LinksAllAsync(factory));

        shelves.Select(s => s.Name).Should().Equal("a", "b", "c");
        handler.Requests.Should().HaveCount(3);
        handler.Requests[1].Uri.Should().Be(new Uri("https://api.test/shelves/links?cursor=2"));
        handler.Requests[2].Uri.Should().Be(new Uri("https://api.test/shelves/links?cursor=3"));
    }

    [TestMethod]
    public async Task Header_and_cookie_parameters_go_with_every_continuation_in_the_same_wire_format()
    {
        var (client, factory, handler) = Paging.Container();
        handler
            .RespondJson("""{"items":[{"name":"a"}],"next":"https://api.test/shelves/links?cursor=2"}""")
            .RespondJson("""{"items":[{"name":"b"}]}""");

        await Paging.All(client.Shelves.LinksAllAsync(factory, tenant: "acme", since: Since, session: "s-1"));

        handler.Requests.Should().HaveCount(2);
        var (first, second) = (handler.Requests[0].Headers, handler.Requests[1].Headers);
        second["X-Tenant"].Should().Be("acme").And.Be(first["X-Tenant"]);
        second["If-Modified-Since"].Should().Be("Tue, 02 Jan 2024 03:04:05 GMT").And.Be(first["If-Modified-Since"]);
        second["Cookie"].Should().Contain("s-1").And.Be(first["Cookie"]);
    }

    [TestMethod]
    public async Task A_string_next_link_resolves_against_the_base_address_and_an_empty_one_ends_the_loop()
    {
        var (client, factory, handler) = Paging.Container();
        handler
            .RespondJson("""{"items":[{"name":"a"}],"next":"shelves/relative?p=2"}""")
            .RespondJson("""{"items":[{"name":"b"}],"next":""}""");

        var shelves = await Paging.All(client.Shelves.RelativeAllAsync(factory));

        shelves.Select(s => s.Name).Should().Equal("a", "b");
        handler.Requests.Should().HaveCount(2);
        handler.Requests[1].Uri.Should().Be(new Uri("https://api.test/shelves/relative?p=2"));
    }

    [TestMethod]
    public async Task A_discriminated_page_that_narrows_its_items_yields_what_its_inherited_property_holds()
    {
        var (client, factory, handler) = Paging.Container();
        handler
            .RespondJson("""{"kind":"signed","items":[{"title":"a","signedBy":"x"}],"next":"/catalogs?cursor=2"}""")
            .RespondJson("""{"kind":"signed","items":[{"title":"b","signedBy":"y"}]}""");

        var books = await Paging.All(client.Catalogs.SignedAllAsync(factory));

        books.Select(b => b.Title).Should().Equal("a", "b");
        handler.Requests.Should().HaveCount(2);
    }

    [TestMethod]
    [DataRow("https://elsewhere.test/shelves/links?cursor=2")]
    [DataRow("http://api.test/shelves/links?cursor=2")]
    [DataRow("https://api.test:8443/shelves/links?cursor=2")]
    public async Task A_next_link_to_another_origin_throws_before_anything_is_sent_there(string next)
    {
        var (client, factory, handler) = Paging.Container();
        handler.RespondJson($$"""{"items":[{"name":"a"}],"next":"{{next}}"}""");

        var act = async () => await Paging.All(client.Shelves.LinksAllAsync(factory, tenant: "acme"));

        await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("Refusing to follow*");
        handler.Requests.Should().ContainSingle();
    }
}

/// <summary>Helpers shared by the paging tests.</summary>
internal static class Paging
{
    /// <summary>Reads every item a paging wrapper yields.</summary>
    /// <typeparam name="T">The item type.</typeparam>
    /// <param name="items">The wrapper's enumeration.</param>
    /// <returns>The items, in order.</returns>
    public static async Task<List<T>> All<T>(IAsyncEnumerable<T> items)
    {
        var all = new List<T>();
        await foreach (var item in items) all.Add(item);
        return all;
    }

    /// <summary>
    /// Builds the kitchen-sink client through its registration method, with the stub as every
    /// endpoint's primary handler, and returns the container's <see cref="IHttpClientFactory"/>
    /// the next-link wrappers resolve the interface's named client from.
    /// </summary>
    /// <returns>The client, the factory, and the handler that stands in for the network.</returns>
    public static (KitchenSinkClient Client, IHttpClientFactory Factory, StubHandler Handler) Container()
    {
        var handler = new StubHandler();
        var services = new ServiceCollection();
        services.AddKitchenSinkClient(
            http => http.BaseAddress = Harness.BaseAddress,
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler));
        var provider = services.BuildServiceProvider();
        return (provider.GetRequiredService<KitchenSinkClient>(), provider.GetRequiredService<IHttpClientFactory>(), handler);
    }
}

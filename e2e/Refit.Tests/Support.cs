using System.Net;
using System.Net.Http.Headers;
using System.Text;
using MassiveScale.KitchenSink.Client;
using MassiveScale.Simple.Api.Example.Client;
using Microsoft.Extensions.DependencyInjection;
using V1 = MassiveScale.AllVersions.Client.V1_0;
using V2 = MassiveScale.AllVersions.Client.V2_0;

namespace RefitClient.Tests;

/// <summary>A request the stub handler saw, captured before the content is disposed.</summary>
/// <param name="Method">The HTTP method.</param>
/// <param name="Uri">The full request URI.</param>
/// <param name="Headers">The request headers, each one's values joined with commas.</param>
/// <param name="ContentType">The body's <c>Content-Type</c>, or <see langword="null"/> without a body.</param>
/// <param name="Body">The body as UTF-8 text, or <see langword="null"/> without a body.</param>
/// <param name="BodyBytes">The body as it was sent, or <see langword="null"/> without a body.</param>
public sealed record RecordedRequest(
    HttpMethod Method,
    Uri Uri,
    IReadOnlyDictionary<string, string> Headers,
    string? ContentType,
    string? Body,
    byte[]? BodyBytes);

/// <summary>
/// Stands in for the network. Queued responses are returned in order; every request is recorded.
/// With nothing queued it answers <c>204 No Content</c>.
/// </summary>
public sealed class StubHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, byte[] Body, string ContentType)> _responses = new();

    /// <summary>Gets every request seen, oldest first.</summary>
    public List<RecordedRequest> Requests { get; } = [];

    /// <summary>Gets the most recent request.</summary>
    public RecordedRequest Last => Requests[^1];

    /// <summary>Queues a JSON response.</summary>
    /// <param name="json">The response body.</param>
    /// <param name="status">The status code; <c>200 OK</c> when omitted.</param>
    /// <returns>This handler, so responses can be chained.</returns>
    public StubHandler RespondJson(string json, HttpStatusCode status = HttpStatusCode.OK)
    {
        _responses.Enqueue((status, Encoding.UTF8.GetBytes(json), "application/json"));
        return this;
    }

    /// <summary>Queues a <c>text/plain</c> response.</summary>
    /// <param name="text">The response body.</param>
    /// <returns>This handler, so responses can be chained.</returns>
    public StubHandler RespondText(string text)
    {
        _responses.Enqueue((HttpStatusCode.OK, Encoding.UTF8.GetBytes(text), "text/plain"));
        return this;
    }

    /// <summary>Queues an <c>application/octet-stream</c> response.</summary>
    /// <param name="data">The response body.</param>
    /// <returns>This handler, so responses can be chained.</returns>
    public StubHandler RespondBytes(byte[] data)
    {
        _responses.Enqueue((HttpStatusCode.OK, data, "application/octet-stream"));
        return this;
    }

    /// <inheritdoc />
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // A real handler stops on a cancelled token, so the stub does too, to show the token got here.
        cancellationToken.ThrowIfCancellationRequested();

        byte[]? bytes = null;
        if (request.Content is not null)
        {
            bytes = await request.Content.ReadAsByteArrayAsync(cancellationToken);
        }

        Requests.Add(new RecordedRequest(
            request.Method,
            request.RequestUri!,
            request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value)),
            request.Content?.Headers.ContentType?.ToString(),
            bytes is null ? null : Encoding.UTF8.GetString(bytes),
            bytes));

        var (status, body, contentType) = _responses.Count > 0
            ? _responses.Dequeue()
            : (HttpStatusCode.NoContent, [], "application/json");

        // Refit reads the request back from the response, as a real HttpClientHandler sets it.
        var response = new HttpResponseMessage(status) { Content = new ByteArrayContent(body), RequestMessage = request };
        response.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        return response;
    }
}

/// <summary>
/// A delegating handler a caller adds through the registration method, which records the headers
/// it sees, to check the generated wire handler has already written them.
/// </summary>
public sealed class HeaderRecorder : DelegatingHandler
{
    /// <summary>Gets the headers of every request seen, oldest first.</summary>
    public List<IReadOnlyDictionary<string, string>> Seen { get; } = [];

    /// <inheritdoc />
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Seen.Add(request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value)));
        return base.SendAsync(request, cancellationToken);
    }
}

/// <summary>How a test builds the client it calls: the two ways users will.</summary>
public enum Wiring
{
    /// <summary>The generated static <c>{Client}.Create(baseAddress, innerHandler)</c>.</summary>
    Create,

    /// <summary>The generated <c>Add{Client}</c> registration, with the stub as the primary handler.</summary>
    DependencyInjection,
}

/// <summary>Builds clients wired to a <see cref="StubHandler"/>.</summary>
public static class Harness
{
    /// <summary>The base address every client is given.</summary>
    public static readonly Uri BaseAddress = new("https://api.test/");

    /// <summary>Builds the kitchen-sink client.</summary>
    /// <param name="wiring">How the client is built.</param>
    /// <returns>The client and the handler that stands in for the network.</returns>
    public static (KitchenSinkClient Client, StubHandler Handler) KitchenSink(Wiring wiring = Wiring.Create)
    {
        var handler = new StubHandler();
        return (Build<KitchenSinkClient>(wiring, handler, KitchenSinkClient.Create, KitchenSinkClientExtensions.AddKitchenSinkClient), handler);
    }

    /// <summary>Builds the simple-api client.</summary>
    /// <param name="wiring">How the client is built.</param>
    /// <returns>The client and the handler that stands in for the network.</returns>
    public static (ExampleClient Client, StubHandler Handler) Simple(Wiring wiring = Wiring.Create)
    {
        var handler = new StubHandler();
        return (Build<ExampleClient>(wiring, handler, ExampleClient.Create, ExampleClientExtensions.AddExampleClient), handler);
    }

    /// <summary>Builds the all-versions client for version 1.0.</summary>
    /// <param name="wiring">How the client is built.</param>
    /// <returns>The client and the handler that stands in for the network.</returns>
    public static (V1.AllVersionsClient Client, StubHandler Handler) AllVersionsV1(Wiring wiring = Wiring.Create)
    {
        var handler = new StubHandler();
        return (Build<V1.AllVersionsClient>(wiring, handler, V1.AllVersionsClient.Create, V1.AllVersionsClientExtensions.AddAllVersionsClient), handler);
    }

    /// <summary>Builds the all-versions client for version 2.0.</summary>
    /// <param name="wiring">How the client is built.</param>
    /// <returns>The client and the handler that stands in for the network.</returns>
    public static (V2.AllVersionsClient Client, StubHandler Handler) AllVersionsV2(Wiring wiring = Wiring.Create)
    {
        var handler = new StubHandler();
        return (Build<V2.AllVersionsClient>(wiring, handler, V2.AllVersionsClient.Create, V2.AllVersionsClientExtensions.AddAllVersionsClient), handler);
    }

    /// <summary>
    /// Builds a generated client either through its static <c>Create</c> or through its registration
    /// method and a service provider, sending every request to <paramref name="handler"/>.
    /// </summary>
    /// <typeparam name="TClient">The aggregate client, as the container registers it (`Create` returns its `Standalone` subclass).</typeparam>
    /// <param name="wiring">How the client is built.</param>
    /// <param name="handler">The handler that stands in for the network.</param>
    /// <param name="create">The generated <c>Create(baseAddress, innerHandler)</c>.</param>
    /// <param name="register">The generated <c>Add{Client}(services, configureHttpClient, configureBuilder)</c>.</param>
    /// <returns>The client.</returns>
    public static TClient Build<TClient>(
        Wiring wiring,
        HttpMessageHandler handler,
        Func<Uri, HttpMessageHandler?, TClient> create,
        Func<IServiceCollection, Action<HttpClient>, Func<IHttpClientBuilder, IHttpClientBuilder>?, IServiceCollection> register)
        where TClient : notnull
    {
        if (wiring == Wiring.Create) return create(BaseAddress, handler);

        var services = new ServiceCollection();
        register(
            services,
            http => http.BaseAddress = BaseAddress,
            builder => builder.ConfigurePrimaryHttpMessageHandler(() => handler));
        return services.BuildServiceProvider().GetRequiredService<TClient>();
    }

    /// <summary>
    /// Finds an exception of a type in a chain of inner exceptions, so a test can check what failed
    /// whether or not Refit wrapped it in an <c>ApiException</c>.
    /// </summary>
    /// <typeparam name="T">The exception type.</typeparam>
    /// <param name="exception">The exception that was thrown.</param>
    /// <returns>The first exception of that type, or <see langword="null"/>.</returns>
    public static T? Find<T>(Exception? exception) where T : Exception
    {
        for (var e = exception; e is not null; e = e.InnerException)
        {
            if (e is T match) return match;
        }

        return null;
    }
}

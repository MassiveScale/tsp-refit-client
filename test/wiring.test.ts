import { ok, doesNotMatch } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics, fileContent } from "./host.js";

const TWO_INTERFACES = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;

  @route("/pets")
  interface Pets { @get list(): string[]; }

  @route("/stores")
  interface Stores { @get list(): string[]; }
`;

describe("aggregate client", () => {
  it("exposes every Refit interface through a null-checking constructor", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(content.includes("public IPets Pets { get; }"));
    ok(content.includes("public IStores Stores { get; }"));
    ok(content.includes("public TestApiClient(IPets pets, IStores stores)"));
    ok(
      content.includes(
        "this.Pets = pets ?? throw new ArgumentNullException(nameof(pets));",
      ),
    );
  });

  it("can be created from a base address and an optional inner handler", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "public static Standalone Create(Uri baseAddress, HttpMessageHandler? innerHandler = null)",
      ),
    );
    ok(
      content.includes(
        "global::TestApi.Client.ClientRuntime.CreateHandler(innerHandler ?? new HttpClientHandler()))",
      ),
    );
    ok(
      content.includes(
        ": base(global::Refit.RestService.For<IPets>(httpClient, settings), global::Refit.RestService.For<IStores>(httpClient, settings))",
      ),
    );
  });

  it("returns a client from Create that owns and disposes the HttpClient it built", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "public sealed class Standalone : TestApiClient, IDisposable",
      ),
    );
    ok(content.includes("public void Dispose() => _httpClient.Dispose();"));
    ok(
      content.includes(
        "internal Standalone(HttpClient httpClient, RefitSettings settings)",
      ),
      "Only Create makes one, so the client never owns a caller's HttpClient",
    );
    ok(
      content.includes("public class TestApiClient\n"),
      "The registered client stays non-disposable, so the container never tracks it",
    );
  });

  it("writes the runtime and RestService in full, so an endpoint property cannot hide them", async () => {
    const outputs = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/runtime")
      interface ClientRuntime { @get read(): string; }

      @route("/rest")
      interface RestService { @get read(): string; }
    `);
    const content = fileContent(outputs, "TestApiClientExtensions.g.cs");

    ok(content.includes("public IClientRuntime ClientRuntime { get; }"));
    ok(content.includes("public IRestService RestService { get; }"));
    doesNotMatch(
      content
        .split("public static class")[0]
        .split("\n")
        .filter((line) => !line.trim().startsWith("///"))
        .join("\n"),
      /[^.:]\b(ClientRuntime|RestService)\.(CreateSettings|CreateHandler|For)\b/,
      "Inside the client, the bare names are its properties",
    );
  });

  it("reports an interface or client-name that takes the name of the nested Standalone class", async () => {
    const [, interfaceDiagnostics] = await emitWithDiagnostics(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/s")
      interface Standalone { @get read(): string; }
    `);
    ok(
      interfaceDiagnostics.some(
        (d) =>
          d.code.endsWith("name-collision") &&
          d.message.includes("nested Standalone class"),
      ),
    );

    const [, optionDiagnostics] = await emitWithDiagnostics(TWO_INTERFACES, {
      "client-name": "Standalone",
    });
    ok(
      optionDiagnostics.some(
        (d) =>
          d.code.endsWith("invalid-option") &&
          d.message.includes("nested Standalone class"),
      ),
    );
  });

  it("exposes the Refit settings and message handler for interfaces created by hand", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "public static RefitSettings CreateRefitSettings() => global::TestApi.Client.ClientRuntime.CreateSettings();",
      ),
    );
    ok(
      content.includes(
        "public static DelegatingHandler CreateHttpMessageHandler(HttpMessageHandler? innerHandler = null) =>",
      ),
    );
  });

  it("keeps an internal interface's property and the constructor internal", async () => {
    const content = fileContent(
      await emit(`
        import "@typespec/http";
        import "@massivescale/tsp-refit-client";
        using Http;
        using MassiveScale.TspRefitClient;

        @service(#{ title: "Test API" })
        namespace TestApi;

        @route("/pets")
        interface Pets { @get list(): string[]; }

        @access(Access.internal)
        @route("/hidden")
        interface Hidden { @get list(): string[]; }
      `),
      "TestApiClientExtensions.g.cs",
    );

    ok(content.includes("public IPets Pets { get; }"));
    ok(content.includes("internal IHidden Hidden { get; }"));
    ok(content.includes("internal TestApiClient(IPets pets, IHidden hidden)"));
  });
});

describe("dependency injection registration", () => {
  it("registers every interface as a Refit client with the runtime settings and handler", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "AddEndpoint<IPets>(services, configureHttpClient, configureBuilder);",
      ),
    );
    ok(
      content.includes(
        "AddEndpoint<IStores>(services, configureHttpClient, configureBuilder);",
      ),
    );
    ok(content.includes(".AddRefitClient<T>(ClientRuntime.CreateSettings())"));
    ok(content.includes(".ConfigureHttpClient(configureHttpClient)"));
    ok(
      content.includes(
        ".AddHttpMessageHandler(() => ClientRuntime.CreateHandler());",
      ),
    );
  });

  it("registers the aggregate client from the registered interfaces", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "services.AddTransient(serviceProvider => new TestApiClient(serviceProvider.GetRequiredService<IPets>(), serviceProvider.GetRequiredService<IStores>()));",
      ),
    );
  });

  it("lets callers add handlers to each interface's HttpClient", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES),
      "TestApiClientExtensions.g.cs",
    );

    ok(
      content.includes(
        "Func<IHttpClientBuilder, IHttpClientBuilder>? configureBuilder = null)",
      ),
    );
    ok(content.includes("configureBuilder?.Invoke(builder);"));
  });

  it("names the classes and the registration method after client-name", async () => {
    const content = fileContent(
      await emit(TWO_INTERFACES, { "client-name": "PetStore" }),
      "PetStoreExtensions.g.cs",
    );

    ok(content.includes("public class PetStore"));
    ok(content.includes("public static class PetStoreExtensions"));
    ok(content.includes("public static IServiceCollection AddPetStore("));
  });

  it("escapes an interface whose parameter name is a C# keyword", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/params")
      interface Params { @get list(): string[]; }
    `);

    const content = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(content.includes("IParams @params"));
    ok(
      content.includes(
        "this.Params = @params ?? throw new ArgumentNullException(nameof(@params));",
      ),
    );
  });
});

describe("project file", () => {
  it("references Refit and its HttpClient factory integration, not Flurl", async () => {
    const content = fileContent(await emit(TWO_INTERFACES), ".csproj");

    ok(content.includes('<PackageReference Include="Refit" Version="11.*" />'));
    ok(
      content.includes(
        '<PackageReference Include="Refit.HttpClientFactory" Version="11.*" />',
      ),
    );
    doesNotMatch(content, /Flurl/);
  });

  it("describes the package as a Refit client by default", async () => {
    const content = fileContent(await emit(TWO_INTERFACES), ".csproj");

    ok(
      content.includes(
        "<Description>Refit client for the TestApi.Client API</Description>",
      ),
    );
  });
});

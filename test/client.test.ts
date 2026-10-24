import { ok } from "node:assert";
import { describe, it } from "node:test";
import { emit } from "./host.js";

describe("client", () => {
  it("uses client-name for extensions class and method name", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "client-name": "PetStore" },
    );

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("PetStoreExtensions.g.cs"),
    );
    ok(extFile, "Expected PetStoreExtensions.g.cs");
    const extContent = results[extFile];
    ok(
      extContent.includes("class PetStore"),
      "Expected PetStore aggregate class",
    );
    ok(
      extContent.includes("class PetStoreExtensions"),
      "Expected PetStoreExtensions class",
    );
    ok(extContent.includes("AddPetStore"), "Expected AddPetStore method");

    const defaultExt = Object.keys(results).find((k) =>
      k.endsWith("TestApiClientExtensions.g.cs"),
    );
    ok(
      !defaultExt,
      "Default extensions file should not be emitted when client-name is set",
    );
  });

  it("emits an aggregate client class with one property per interface", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Pet { name: string; }
      model Store { name: string; }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }

      @route("/stores")
      interface Stores {
        @get list(): Store[];
      }
    `);

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("TestApiClientExtensions.g.cs"),
    );
    ok(extFile, "Expected TestApiClientExtensions.g.cs");
    const content = results[extFile];

    ok(
      content.includes("public class TestApiClient"),
      "Expected aggregate class declaration",
    );
    ok(
      content.includes("public IPets Pets { get; }"),
      "Expected Pets property",
    );
    ok(
      content.includes("public IStores Stores { get; }"),
      "Expected Stores property",
    );
    ok(content.includes("IPets pets"), "Expected pets constructor param");
    ok(content.includes("IStores stores"), "Expected stores constructor param");
    ok(
      content.includes(
        "this.Pets = pets ?? throw new ArgumentNullException(nameof(pets));",
      ),
      "Expected a null-checked Pets assignment in the constructor",
    );
    ok(
      content.includes(
        "this.Stores = stores ?? throw new ArgumentNullException(nameof(stores));",
      ),
      "Expected a null-checked Stores assignment in the constructor",
    );
    ok(
      content.includes(
        "services.AddTransient(serviceProvider => new TestApiClient(serviceProvider.GetRequiredService<IPets>(), serviceProvider.GetRequiredService<IStores>()));",
      ),
      "Expected the aggregate client registered as transient, built from the registered interfaces",
    );
    ok(
      content.includes(
        "AddEndpoint<IPets>(services, configureHttpClient, configureBuilder);",
      ),
      "Expected IPets registered",
    );
    ok(
      content.includes(
        "AddEndpoint<IStores>(services, configureHttpClient, configureBuilder);",
      ),
      "Expected IStores registered",
    );
  });

  it("registers each interface as a Refit client with the runtime's settings and message handler", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/pets")
      interface Pets {
        @get list(): string[];
      }
    `);

    const content = results["TestApiClientExtensions.g.cs"];
    ok(content, "Expected TestApiClientExtensions.g.cs");
    ok(
      content.includes(
        ".AddRefitClient<T>(settings ?? ClientRuntime.CreateSettings(), httpClientName)",
      ),
      "Expected the interface registered with the runtime's Refit settings",
    );
    ok(
      content.includes(".ConfigureHttpClient(configureHttpClient)"),
      "Expected the caller's HttpClient configuration applied",
    );
    ok(
      content.includes(
        ".AddHttpMessageHandler(() => ClientRuntime.CreateHandler());",
      ),
      "Expected the runtime's wire handler added to every interface",
    );
    ok(
      content.includes("configureBuilder?.Invoke(builder);"),
      "Expected the optional builder callback applied",
    );
    ok(
      content.includes(
        "if (services is null) throw new ArgumentNullException(nameof(services));",
      ) &&
        content.includes(
          "if (configureHttpClient is null) throw new ArgumentNullException(nameof(configureHttpClient));",
        ),
      "Expected the registration method to null-check its arguments",
    );
    ok(
      !content.includes("Flurl"),
      "Did not expect any Flurl type in a Refit client",
    );
  });

  it("emits factories that create the client without dependency injection", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/pets")
      interface Pets {
        @get list(): string[];
      }

      @route("/stores")
      interface Stores {
        @get list(): string[];
      }
    `);

    const content = results["TestApiClientExtensions.g.cs"];
    ok(content, "Expected TestApiClientExtensions.g.cs");
    ok(
      content.includes(
        "public static RefitSettings CreateRefitSettings() => global::TestApi.Client.ClientRuntime.CreateSettings();",
      ),
      "Expected a factory for the Refit settings",
    );
    ok(
      content.includes(
        "public static DelegatingHandler CreateHttpMessageHandler(HttpMessageHandler? innerHandler = null) =>",
      ) &&
        content.includes(
          "global::TestApi.Client.ClientRuntime.CreateHandler(innerHandler);",
        ),
      "Expected a factory for the message handler",
    );
    ok(
      content.includes(
        "public static Standalone Create(Uri baseAddress, HttpMessageHandler? innerHandler = null)",
      ),
      "Expected a Create factory that takes a base address",
    );
    ok(
      content.includes(
        "global::TestApi.Client.ClientRuntime.CreateHandler(innerHandler ?? new HttpClientHandler()))",
      ),
      "Expected Create to put the wire handler in front of the inner handler",
    );
    ok(
      content.includes(
        ": base(global::Refit.RestService.For<IPets>(httpClient, settings), global::Refit.RestService.For<IStores>(httpClient, settings))",
      ),
      "Expected Create to build every interface with the shared HttpClient and settings",
    );
  });

  it("registers a non-paginated interface's call site exactly as before, with no extra arguments", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("TestApiClientExtensions.g.cs"),
    );
    ok(extFile, "Expected TestApiClientExtensions.g.cs");
    ok(
      results[extFile].includes(
        "AddEndpoint<IItems>(services, configureHttpClient, configureBuilder);",
      ),
      "Expected the plain, no-extra-arguments call site unchanged by the paging feature",
    );
  });
});

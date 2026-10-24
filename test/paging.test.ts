import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

describe("paging", () => {
  describe("nextLink strategy", () => {
    it("emits both the raw method and a nextLink-following ListAllAsync wrapper", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          totalCount?: int32;
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query skip?: int32, @query take?: int32): PagedResult<Store>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IStores.g.cs"),
      );
      ok(ifaceFile, "Expected IStores.g.cs");
      const content = results[ifaceFile];

      ok(
        content.includes("Task<PagedResult<Store>> ListAsync("),
        "Expected raw ListAsync method unchanged",
      );
      ok(
        content.includes("IStoresPagingExtensions"),
        "Expected IStoresPagingExtensions class",
      );
      ok(
        content.includes(
          "public static async IAsyncEnumerable<Store> ListAllAsync(",
        ),
        "Expected ListAllAsync wrapper",
      );
      ok(
        content.includes("IHttpClientFactory httpClientFactory"),
        "Expected httpClientFactory parameter for nextLink strategy",
      );
      ok(
        content.includes(
          'httpClientFactory.CreateClient("TestApi.Client.IStores")',
        ),
        "Expected a namespace-qualified named HttpClient, so an identically-named interface in a different service/version can't collide with it",
      );
      ok(
        content.includes("[EnumeratorCancellation] CancellationToken"),
        "Expected EnumeratorCancellation on the wrapper's cancellation token",
      );
      ok(
        content.includes("page.Next"),
        "Expected the PascalCase nextLink property to be read",
      );
      ok(
        content.includes(
          "ReadFromJsonAsync<PagedResult<Store>>(RefitJsonOptions.Default",
        ),
        "Expected manual deserialization using the shared RefitJsonOptions",
      );

      const jsonOptionsFile = Object.keys(results).find((k) =>
        k.endsWith("RefitJsonOptions.g.cs"),
      );
      ok(jsonOptionsFile, "Expected RefitJsonOptions.g.cs to be emitted");

      const extFile = Object.keys(results).find((k) =>
        k.endsWith("TestApiClientExtensions.g.cs"),
      );
      ok(extFile, "Expected TestApiClientExtensions.g.cs");
      ok(
        results[extFile].includes(
          'AddEndpoint<IStores>(services, configureHttpClient, configureBuilder, "TestApi.Client.IStores", new RefitSettings(new SystemTextJsonContentSerializer(RefitJsonOptions.Default)));',
        ),
        "Expected named-client DI registration, under the same namespace-qualified name the wrapper resolves",
      );
    });
  });

  describe("continuationToken strategy", () => {
    it("emits a continuationToken-following wrapper with no nextLink machinery", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(@query @continuationToken continuationToken?: string): TokenPagedResult<Pet>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IPets.g.cs"),
      );
      ok(ifaceFile, "Expected IPets.g.cs");
      const content = results[ifaceFile];

      ok(
        content.includes(
          "public static async IAsyncEnumerable<Pet> ListAllAsync(",
        ),
        "Expected ListAllAsync wrapper",
      );
      ok(
        !content.includes("IHttpClientFactory"),
        "continuationToken strategy must not need an HttpClientFactory",
      );
      ok(
        content.includes("var token = continuationToken;"),
        "Expected the token seeded from the input parameter",
      );
      ok(
        content.includes("token = page.ContinuationToken;"),
        "Expected the token refreshed from the response each iteration",
      );
      ok(
        content.includes("while (!string.IsNullOrEmpty(token));"),
        "Expected the loop to stop once the token is empty",
      );

      ok(
        !Object.keys(results).some((k) => k.endsWith("RefitJsonOptions.g.cs")),
        "continuationToken strategy must not emit the RefitJsonOptions helper",
      );

      const extFile = Object.keys(results).find((k) =>
        k.endsWith("TestApiClientExtensions.g.cs"),
      );
      ok(extFile, "Expected TestApiClientExtensions.g.cs");
      ok(
        results[extFile].includes(
          "AddEndpoint<IPets>(services, configureHttpClient, configureBuilder);",
        ),
        "Expected the plain, unmodified DI registration for the continuationToken-strategy interface",
      );
    });

    it("falls back to the raw method and warns when the output token has no matching input parameter", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(): TokenPagedResult<Pet>;
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");
      strictEqual(warning!.severity, "warning");

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IPets.g.cs"),
      );
      ok(ifaceFile, "Expected IPets.g.cs");
      ok(
        !results[ifaceFile].includes("ListAllAsync"),
        "Expected no wrapper to be generated",
      );
      ok(
        results[ifaceFile].includes("Task<TokenPagedResult<Pet>> ListAsync("),
        "Expected the raw method to still be generated",
      );
    });
  });

  describe("offset / pageIndex strategy", () => {
    it("emits an offset-following wrapper that stops on an empty page", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model OffsetPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @offset offset?: int32, @query take?: int32): OffsetPagedResult<Customer>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("ICustomers.g.cs"),
      );
      ok(ifaceFile, "Expected ICustomers.g.cs");
      const content = results[ifaceFile];

      ok(
        content.includes(
          "public static async IAsyncEnumerable<Customer> ListAllAsync(",
        ),
        "Expected ListAllAsync wrapper",
      );
      ok(
        content.includes("var currentOffset = offset ?? 0;"),
        "Expected the optional offset parameter seeded with ?? 0",
      );
      ok(
        content.includes("currentOffset += (int)count;"),
        "Expected the offset advanced by the number of items actually received, cast to the counter's own type",
      );
      ok(
        content.includes("if (count == 0) yield break;"),
        "Expected the loop to stop on an empty page",
      );
      ok(
        !Object.keys(results).some((k) => k.endsWith("RefitJsonOptions.g.cs")),
        "offset strategy must not emit the RefitJsonOptions helper",
      );
    });

    it("emits a pageIndex-following wrapper that increments by one per page", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model IndexedPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @pageIndex pageIndex?: int32): IndexedPagedResult<Customer>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("ICustomers.g.cs"),
      );
      ok(ifaceFile, "Expected ICustomers.g.cs");
      const content = results[ifaceFile];

      ok(
        content.includes("var currentPageIndex = pageIndex ?? 0;"),
        "Expected the pageIndex counter seeded from the input parameter",
      );
      ok(
        content.includes("currentPageIndex++;"),
        "Expected the page index advanced by one per iteration",
      );
    });
  });

  describe("priority when multiple signals are present", () => {
    it("prefers nextLink over continuationToken", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model MultiPagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
          @continuationToken continuationToken?: string;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(@query @continuationToken continuationToken?: string): MultiPagedResult<Widget>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IWidgets.g.cs"),
      );
      ok(ifaceFile, "Expected IWidgets.g.cs");
      const content = results[ifaceFile];
      ok(
        content.includes(
          'httpClientFactory.CreateClient("TestApi.Client.IWidgets")',
        ),
        "Expected the nextLink strategy to win over continuationToken",
      );
      ok(
        !content.includes("while (!string.IsNullOrEmpty(token));"),
        "Expected no continuationToken loop to be generated",
      );
    });
  });

  describe("local name collisions with forwarded parameters", () => {
    it("renames the continuationToken loop variable when a parameter is literally named token", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(@query @continuationToken token?: string): TokenPagedResult<Pet>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IPets.g.cs"))!];
      ok(
        content.includes("var token2 = token;"),
        "Expected the loop-local token variable renamed to avoid shadowing the token parameter",
      );
      ok(
        content.includes("token2 = page.ContinuationToken;") &&
          content.includes("while (!string.IsNullOrEmpty(token2));"),
        "Expected every reference to use the renamed variable consistently",
      );
    });

    it("renames nextLink's page/httpClient/request locals when parameters use those names", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query page?: int32, @query httpClient?: string, @query request?: string): PagedResult<Store>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        content.includes("var page2 = await client.ListAsync("),
        "Expected the first-page variable renamed to avoid shadowing the page parameter",
      );
      ok(
        content.includes("var httpClient2 = httpClientFactory.CreateClient("),
        "Expected the HttpClient variable renamed to avoid shadowing the httpClient parameter",
      );
      ok(
        content.includes("new HttpRequestMessage(HttpMethod.Get, nextLink)") &&
          content.includes("using var request2 ="),
        "Expected the HttpRequestMessage variable renamed to avoid shadowing the request parameter",
      );
    });

    it("renames the receiver and httpClientFactory parameters when operation parameters use those names", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query client?: string, @query httpClientFactory?: string): PagedResult<Store>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        content.includes(
          "this IStores client2, IHttpClientFactory httpClientFactory2,",
        ),
        "Expected both the extension-method receiver and the IHttpClientFactory parameter renamed to avoid shadowing the operation's own client/httpClientFactory parameters",
      );
      ok(
        content.includes("await client2.ListAsync(") &&
          content.includes('httpClientFactory2.CreateClient("'),
        "Expected every reference inside the wrapper to use the renamed parameters consistently",
      );
    });

    it("renames the receiver for the continuationToken and offset/pageIndex strategies too", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Pet { name: string; }

        model TokenPagedResult<T> {
          @pageItems items: T[];
          @continuationToken continuationToken?: string;
        }

        @route("/pets")
        interface Pets {
          @list @get list(@query client?: string, @query @continuationToken continuationToken?: string): TokenPagedResult<Pet>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IPets.g.cs"))!];
      ok(
        content.includes("this IPets client2,") &&
          content.includes("await client2.ListAsync("),
        "Expected the receiver renamed and used consistently for the continuationToken strategy too",
      );
    });

    it("renames offset/pageIndex's count variable when a parameter is literally named count", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model OffsetPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @offset offset?: int32, @query count?: int32): OffsetPagedResult<Customer>;
        }
      `);

      const content =
        results[
          Object.keys(results).find((k) => k.endsWith("ICustomers.g.cs"))!
        ];
      ok(
        content.includes("var count2 = 0;") &&
          content.includes("count2++;") &&
          content.includes("if (count2 == 0) yield break;") &&
          content.includes("currentOffset += (int)count2;"),
        "Expected the item-count variable renamed to avoid shadowing the count parameter",
      );
    });
  });

  describe("headers on nextLink continuation requests", () => {
    it("replays an optional header parameter on every continuation request", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@header("X-Tenant-Id") tenantId?: string): PagedResult<Store>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        content.includes(
          'if (tenantId is not null) request.Headers.TryAddWithoutValidation("X-Tenant-Id", tenantId.ToString());',
        ),
        "Expected the optional header replayed, guarded against null",
      );
      ok(
        content.includes(
          "using var response = await httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);",
        ),
        "Expected the continuation request sent via the built HttpRequestMessage",
      );
      ok(
        content.includes(
          "var sameOrigin = httpClient.BaseAddress is not null",
        ) &&
          content.includes(
            "Uri.Compare(nextLink, httpClient.BaseAddress, UriComponents.SchemeAndServer, UriFormat.UriEscaped, StringComparison.OrdinalIgnoreCase) == 0;",
          ) &&
          content.includes("if (sameOrigin)"),
        "Expected headers gated behind a same-origin check, so nextLink can't be used to exfiltrate credentials to a different host",
      );
    });

    it("does not emit a same-origin check at all when the operation has no headers to replay", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@query skip?: int32): PagedResult<Store>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        !content.includes("sameOrigin"),
        "Expected no dead same-origin check when there is nothing to guard",
      );
    });

    it("replays a required header parameter unconditionally", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(@header("Authorization") authorization: string): PagedResult<Store>;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        content.includes(
          'request.Headers.TryAddWithoutValidation("Authorization", authorization.ToString());',
        ) &&
          !content.includes("if (authorization is not null) request.Headers"),
        "Expected the required header replayed unconditionally, with no null guard",
      );
    });
  });

  describe("page type derivation", () => {
    it("uses the operation's actual response type, not wherever @pageItems happens to be declared", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model BasePage<T> {
          @pageItems items: T[];
        }

        model StorePage extends BasePage<Store> {
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): StorePage;
        }
      `);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IStores.g.cs"))!];
      ok(
        content.includes(
          "ReadFromJsonAsync<StorePage>(RefitJsonOptions.Default",
        ),
        "Expected continuation pages deserialized as the actual response type (StorePage), not the base model that merely declares @pageItems",
      );
    });

    it("rejects an anonymous page response with no named C# type to read .Items/.Next from", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        @route("/widgets")
        interface Widgets {
          @list @get list(): { @pageItems items: Widget[]; @nextLink next?: url; };
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");
      ok(warning!.message.includes("anonymous"), warning!.message);

      const content =
        results[Object.keys(results).find((k) => k.endsWith("IWidgets.g.cs"))!];
      ok(!content.includes("ListAllAsync"));
    });
  });

  describe("header-bound paging properties", () => {
    it("rejects a nextLink bound to a response header (surfaces as an anonymous page type)", async () => {
      // `@typespec/http` synthesizes an anonymous implicit body for whatever's
      // left over whenever a response property is pulled out as a header, so
      // this is caught by the same "page type derivation" guard above — not a
      // separate header-specific check — but it's worth its own test, since
      // it's the scenario that motivated that guard in the first place.
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink @header("X-Next-Link") next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");
      ok(warning!.message.includes("anonymous"), warning!.message);
    });
  });

  describe("nullable @pageItems", () => {
    it("rejects an optional items array, which the loop could not safely enumerate when absent", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items?: T[];
          @nextLink next?: url;
        }

        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");
      ok(warning!.message.includes("optional"), warning!.message);
    });
  });

  describe("offset/pageIndex counter default", () => {
    it("seeds the counter from the parameter's declared default instead of hardcoded 0", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model IndexedPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @pageIndex pageIndex?: int32 = 1): IndexedPagedResult<Customer>;
        }
      `);

      const content =
        results[
          Object.keys(results).find((k) => k.endsWith("ICustomers.g.cs"))!
        ];
      ok(
        content.includes("var currentPageIndex = pageIndex ?? 1;"),
        "Expected the declared default (1) honored instead of a hardcoded 0",
      );
    });
  });

  describe("counter type compatibility", () => {
    it("casts the per-page item count to the offset parameter's own type instead of a bare int addition", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model OffsetPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @offset offset?: uint64): OffsetPagedResult<Customer>;
        }
      `);

      const content =
        results[
          Object.keys(results).find((k) => k.endsWith("ICustomers.g.cs"))!
        ];
      ok(
        content.includes("currentOffset += (ulong)count;"),
        "Expected the int item-count cast to ulong before being added to the ulong counter — C# has no built-in += between them otherwise",
      );
    });

    it("needs no cast for pageIndex, since ++ works on any numeric type", async () => {
      const results = await emit(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Customer { name: string; }

        model IndexedPagedResult<T> {
          @pageItems items: T[];
        }

        @route("/customers")
        interface Customers {
          @list @get list(@query @pageIndex pageIndex?: uint64): IndexedPagedResult<Customer>;
        }
      `);

      const content =
        results[
          Object.keys(results).find((k) => k.endsWith("ICustomers.g.cs"))!
        ];
      ok(
        content.includes("currentPageIndex++;"),
        "Expected a plain increment, which needs no cast regardless of the counter's numeric type",
      );
    });
  });

  describe("unsupported shapes", () => {
    it("warns and falls back to the raw method for a nested paging property", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model LinkContainer {
          @nextLink next?: url;
        }

        model NestedPagedResult<T> {
          @pageItems items: T[];
          links: LinkContainer;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): NestedPagedResult<Widget>;
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IWidgets.g.cs"),
      );
      ok(ifaceFile);
      ok(!results[ifaceFile].includes("ListAllAsync"));
    });

    it("warns and falls back to the raw method when no forward-iteration signal is recognized", async () => {
      const [results, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model LinkOnlyPagedResult<T> {
          @pageItems items: T[];
          @prevLink prev?: url;
          @firstLink first?: url;
          @lastLink last?: url;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): LinkOnlyPagedResult<Widget>;
        }
      `);

      const warning = diagnostics.find(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/unsupported-paging-style",
      );
      ok(warning, "Expected an unsupported-paging-style warning");

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IWidgets.g.cs"),
      );
      ok(ifaceFile);
      ok(!results[ifaceFile].includes("ListAllAsync"));
      ok(
        results[ifaceFile].includes(
          "Task<LinkOnlyPagedResult<Widget>> ListAsync(",
        ),
        "Expected the raw method to still be generated",
      );

      const modelFile = Object.keys(results).find((k) =>
        k.endsWith("LinkOnlyPagedResult.g.cs"),
      );
      ok(modelFile, "Expected the page model's record to still be emitted");
      ok(
        results[modelFile].includes("Prev") &&
          results[modelFile].includes("First") &&
          results[modelFile].includes("Last"),
        "Expected prevLink/firstLink/lastLink to still render as ordinary properties",
      );
    });

    it("does not crash and reports the compiler's own diagnostic when @list is missing @pageItems", async () => {
      const [, diagnostics] = await emitWithDiagnostics(`
        import "@typespec/http";
        using Http;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Widget { name: string; }

        model EmptyPagedResult<T> {
          @nextLink next?: url;
        }

        @route("/widgets")
        interface Widgets {
          @list @get list(): EmptyPagedResult<Widget>;
        }
      `);

      // Severity "error" — the compiler's own validatePagingOperations pass
      // reports this and skips emission for the program entirely, before the
      // emitter's own paging detection ever runs.
      const missingItems = diagnostics.find(
        (d) => d.code === "missing-paging-items",
      );
      ok(
        missingItems,
        "Expected the compiler's own missing-paging-items diagnostic",
      );
    });
  });

  describe("access modifier propagation", () => {
    it("emits an internal paging extensions class for an internal interface", async () => {
      const results = await emit(`
        import "@typespec/http";
        import "@massivescale/tsp-refit-client";
        using Http;
        using MassiveScale.TspRefitClient;

        @service(#{ title: "Test API" })
        namespace TestApi;

        model Store { name: string; }

        model PagedResult<T> {
          @pageItems items: T[];
          @nextLink next?: url;
        }

        @access(Access.internal)
        @route("/stores")
        interface Stores {
          @list @get list(): PagedResult<Store>;
        }
      `);

      const ifaceFile = Object.keys(results).find((k) =>
        k.endsWith("IStores.g.cs"),
      );
      ok(ifaceFile);
      ok(
        results[ifaceFile].includes(
          "internal static class IStoresPagingExtensions",
        ),
        "Expected the paging extensions class to match the interface's internal access",
      );
    });
  });
});

import { ok, strictEqual, doesNotMatch } from "node:assert";
import { describe, it } from "node:test";
import { buildRoute } from "../src/endpoints.js";
import { escapeCsIdentifier } from "../src/utils.js";
import { emit, emitWithDiagnostics, fileContent, has } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("buildRoute", () => {
  it("keeps the leading slash", () =>
    strictEqual(buildRoute("/api/items"), "/api/items"));

  it("adds a leading slash when there is none", () =>
    strictEqual(buildRoute("api/items"), "/api/items"));

  it("keeps a path parameter as a Refit placeholder", () =>
    strictEqual(buildRoute("/items/{id}"), "/items/{id}"));

  it("keeps the literal text around several parameters", () =>
    strictEqual(
      buildRoute("/stores/{storeId}/items/{id}/analyze"),
      "/stores/{storeId}/items/{id}/analyze",
    ));

  it("drops RFC 6570 operators and explode markers", () =>
    strictEqual(buildRoute("/a/{+path}/{/id*}"), "/a/{path}/{id}"));

  it("escapes quotes and backslashes for a C# string literal, but not braces", () =>
    strictEqual(buildRoute('/a"b\\c}d'), '/a\\"b\\\\c}d'));
});

describe("escapeCsIdentifier", () => {
  it("prefixes a reserved keyword with @", () =>
    strictEqual(escapeCsIdentifier("params"), "@params"));
  it("leaves any other identifier alone", () =>
    strictEqual(escapeCsIdentifier("widgetId"), "widgetId"));
});

describe("parameter binding", () => {
  it("binds query parameters by wire name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@query("page-size") pageSize?: int32, @query filter?: string): string[];
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes('[AliasAs("page-size")] int? pageSize = null'));
    ok(
      iface.includes(
        'ListAsync([AliasAs("page-size")] int? pageSize = null, string? filter = null,',
      ),
      "A query parameter whose wire name is its C# name needs no alias",
    );
  });

  it("sends a header through the message handler, only when it has a value", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@header("X-Trace") trace?: string): string[];
      }
    `);

    ok(
      fileContent(results, "IItems.g.cs").includes(
        '[Property(ClientRuntime.HeaderPrefix + "X-Trace")] string? trace = null',
      ),
    );
    ok(
      fileContent(results, "ClientRuntime.g.cs").includes(
        "if (value is null) continue;",
      ),
      "The message handler skips a header left out",
    );
  });

  it("binds every path parameter to its route placeholder", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/stores/{storeId}/items/{itemId}")
      interface Items {
        @get read(@path storeId: string, @path itemId: string): string;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes('[Get("/api/stores/{storeId}/items/{itemId}")]'));
    ok(iface.includes("ReadAsync(string storeId, string itemId,"));
  });

  it("escapes a parameter named after a C# keyword", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(@query params?: string, @query event?: string): string[];
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("string? @params = null"));
    ok(iface.includes("string? @event = null"));
  });

  it("does not expose a Content-Type header as a parameter", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @post upload(@header contentType: "application/octet-stream", @body body: bytes): void;
      }
    `);

    const iface = fileContent(results, "IFiles.g.cs");
    ok(
      iface.includes(
        "UploadAsync([Body(BodySerializationMethod.Serialized, true)] byte[] body,",
      ),
    );
    doesNotMatch(iface, /contentType/);
  });

  it("sends every verb with the matching Refit attribute", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @get a(): Item;
        @post b(@body body: Item): Item;
        @put c(@body body: Item): Item;
        @patch d(@body body: Item): Item;
        @delete e(): void;
        @head f(): void;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    for (const verb of ["Get", "Post", "Put", "Patch", "Delete", "Head"]) {
      ok(
        iface.includes(`[${verb}("/api/items")]`),
        `Expected [${verb}("/api/items")]`,
      );
    }
  });
});

describe("payload kinds", () => {
  it("sends a model body as JSON, with no Content-Type to declare", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(
      iface.includes(
        "CreateAsync([Body(BodySerializationMethod.Serialized, true)] Item body,",
      ),
    );
    doesNotMatch(iface, /\[Headers\(/);
  });

  it("sends bytes raw with their media type", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @post upload(@header contentType: "application/octet-stream", @body body: bytes): void;
      }
    `);

    const iface = fileContent(results, "IFiles.g.cs");
    ok(iface.includes('[Headers("Content-Type: application/octet-stream")]'));
    ok(iface.includes("byte[] body,"));
  });

  it("sends plain text raw with its media type", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@header contentType: "text/plain", @body body: string): void;
      }
    `);

    const iface = fileContent(results, "INotes.g.cs");
    ok(iface.includes('[Headers("Content-Type: text/plain")]'));
    ok(iface.includes("string body,"));
  });

  it("sends a string body as text, the TypeSpec default for strings", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@body body: string): void;
      }
    `);

    ok(
      fileContent(results, "INotes.g.cs").includes(
        '[Headers("Content-Type: text/plain")]',
      ),
    );
  });

  it("sends a string body as JSON when JSON is declared", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @post add(@header contentType: "application/json", @body body: string): void;
      }
    `);

    const iface = fileContent(results, "INotes.g.cs");
    ok(
      iface.includes(
        "AddAsync([Body(BodySerializationMethod.Serialized, true)] string body,",
      ),
    );
    doesNotMatch(iface, /\[Headers\(/);
  });

  it("reports a model sent with a non-JSON media type instead of sending it as JSON", async () => {
    const [results, diagnostics] = await emitWithDiagnostics(`${PREAMBLE}
      model Item { name: string; }

      @route("/items")
      interface Items {
        @post create(@header contentType: "application/xml", @body body: Item): void;
        @get list(): Item[];
      }
    `);

    const messages = diagnostics
      .filter((d) => d.code.endsWith("unsupported-feature"))
      .map((d) => d.message);
    strictEqual(messages.length, 1);
    ok(messages[0].includes("application/xml"));
    ok(messages[0].includes('"create"'));
    const iface = fileContent(results, "IItems.g.cs");
    ok(!iface.includes("CreateAsync"), "The operation is left out");
    ok(iface.includes("ListAsync"), "The rest of the client is generated");
  });

  it("declares a byte response as a byte array", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/files")
      interface Files {
        @get download(): { @header contentType: "application/octet-stream"; @body body: bytes };
      }
    `);

    const iface = fileContent(results, "IFiles.g.cs");
    ok(iface.includes("Task<byte[]> DownloadAsync("));
    doesNotMatch(iface, /\[return:/);
  });

  it("declares a plain-text response as a string", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/notes")
      interface Notes {
        @get read(): { @header contentType: "text/plain"; @body body: string };
      }
    `);

    ok(fileContent(results, "INotes.g.cs").includes("Task<string> ReadAsync("));
  });

  it("reads nothing for a response with no body", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @delete remove(@path id: string): void;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task RemoveAsync("));
    doesNotMatch(iface, /Task</);
  });
});

describe("response selection", () => {
  it("reads the first success response that has a body", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }
      @error model Missing { reason: string; }

      @route("/items")
      interface Items {
        @get read(): Item | Missing;
      }
    `);

    const iface = fileContent(results, "IItems.g.cs");
    ok(iface.includes("Task<Item> ReadAsync("));
    ok(
      !iface.includes("Task<Missing>"),
      "The error model is not a success type",
    );
  });

  it("ignores a response with a wildcard status code", async () => {
    const results = await emit(`${PREAMBLE}
      model Item { id: string; }

      @route("/items")
      interface Items {
        @get read(): { @statusCode _: 200; @body body: Item } | { @statusCode _: 404; @body body: string };
      }
    `);

    ok(fileContent(results, "IItems.g.cs").includes("Task<Item> ReadAsync("));
  });
});

describe("access", () => {
  it("generates a public Refit interface and no implementation class", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    ok(fileContent(results, "IItems.g.cs").includes("public interface IItems"));
    ok(
      !has(results, "ItemsEndpoint.g.cs"),
      "Refit implements the interface itself",
    );
  });
});

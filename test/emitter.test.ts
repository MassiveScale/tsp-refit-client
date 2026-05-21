import { strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";

describe("emitter", () => {
  it("emits nothing for an operation with no HTTP service", async () => {
    const results = await emit(`op test(): void;`);
    strictEqual(Object.keys(results).length, 0);
  });

  it("emits a GET interface for a simple HTTP service", async () => {
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

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile, "Expected IItems.cs to be emitted");
    const content = results[ifaceFile];
    ok(content.includes("public interface IItems"), "Expected interface declaration");
    ok(content.includes('[Get("/items")]'), "Expected Get attribute");
    ok(content.includes("Task<List<string>>"), "Expected Task<List<string>> return type");
    ok(content.includes("ListAsync("), "Expected ListAsync method");
  });

  it("emits POST, PATCH, DELETE operations", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
        @patch update(@path id: string, @body body: Item): Item;
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile, "Expected IItems.cs");
    const content = results[ifaceFile];
    ok(content.includes('[Post("/items")]'), "Expected Post attribute");
    ok(content.includes('[Patch("/items/{id}")]'), "Expected Patch attribute");
    ok(content.includes('[Delete("/items/{id}")]'), "Expected Delete attribute");
    ok(content.includes("CreateAsync("), "Expected CreateAsync");
    ok(content.includes("UpdateAsync("), "Expected UpdateAsync");
    ok(content.includes("RemoveAsync("), "Expected RemoveAsync");
  });

  it("emits a void Task for operations with no success body", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile);
    ok(results[ifaceFile].includes("Task RemoveAsync("), "Expected bare Task return");
  });

  it("emits path parameters correctly", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(@path id: string): Widget;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IWidgets.cs"));
    ok(ifaceFile);
    const content = results[ifaceFile];
    ok(content.includes("string id"), "Expected string id parameter");
    ok(content.includes('[Get("/widgets/{id}")]'), "Expected path in attribute");
  });

  it("emits a model record", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("A widget.")
      model Widget {
        @doc("The name.")
        name: string;
        count: int32;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) => k.endsWith("Widget.cs"));
    ok(modelFile, "Expected Widget.cs to be emitted");
    const content = results[modelFile];
    ok(content.includes("public record Widget"), "Expected record declaration");
    ok(content.includes("public string Name"), "Expected Name property");
    ok(content.includes("public int Count"), "Expected int Count property");
    ok(content.includes("/// <summary>A widget.</summary>"), "Expected doc comment");
  });

  it("emits a .csproj file", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    const content = results[csproj];
    ok(content.includes("<PackageReference Include=\"Refit\""), "Expected Refit reference");
    ok(content.includes("net8.0"), "Expected net8.0 target");
  });

  it("defaults to emitting only the latest version for a versioned API", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `);

    const v1File = Object.keys(results).find((k) => k.includes("v1.0") && k.endsWith("IItems.cs"));
    const iItemsFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));

    ok(!v1File, "v1.0 should not be emitted by default");
    ok(iItemsFile, "Expected IItems.cs at root (no version folder in single-version mode)");
    ok(results[iItemsFile!].includes("ListAsync("), "v2 should have ListAsync");
    ok(results[iItemsFile!].includes("CreateAsync("), "v2 should have CreateAsync");
  });

  it("emits a specific version when target-version is set", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "target-version": "v1.0" }
    );

    const v1File = Object.keys(results).find((k) => k.includes("v1.0") && k.endsWith("IItems.cs"));
    const v2File = Object.keys(results).find((k) => k.includes("v2.0") && k.endsWith("IItems.cs"));
    const iItemsFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));

    ok(!v1File, "No v1.0 folder in single-version mode");
    ok(!v2File, "v2.0 should not be emitted when target-version is v1.0");
    ok(iItemsFile, "Expected IItems.cs at root");
    ok(results[iItemsFile!].includes("ListAsync("), "v1 should have ListAsync");
    ok(!results[iItemsFile!].includes("CreateAsync("), "v1 should not have CreateAsync (added in v2)");
  });

  it("emits all versions when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      model Item { id: string; }

      @route("/items")
      interface Items {
        @get list(): Item[];
        @added(Versions.v2)
        @post create(@body body: Item): Item;
      }
    `,
      { "all-versions": true }
    );

    const v1File = Object.keys(results).find((k) => k.includes("v1.0") && k.endsWith("IItems.cs"));
    const v2File = Object.keys(results).find((k) => k.includes("v2.0") && k.endsWith("IItems.cs"));

    ok(v1File, "Expected v1.0/IItems.cs");
    ok(v2File, "Expected v2.0/IItems.cs");
    ok(results[v1File].includes("ListAsync("), "v1 should have ListAsync");
    ok(!results[v1File].includes("CreateAsync("), "v1 should not have CreateAsync");
    ok(results[v2File].includes("ListAsync("), "v2 should have ListAsync");
    ok(results[v2File].includes("CreateAsync("), "v2 should have CreateAsync");
  });

  it("reports an error when target-version does not exist", async () => {
    const [, diags] = await emitWithDiagnostics(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0", v2: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v9.0" }
    );
    ok(
      diags.some((d) => d.code === "tsp-refit-client/version-not-found"),
      "Expected version-not-found diagnostic"
    );
  });

  it("emits an enum for TypeSpec enum types", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Color { Red: "red", Green: "green", Blue: "blue" }

      model Item { color: Color; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const enumFile = Object.keys(results).find((k) => k.endsWith("Color.cs"));
    ok(enumFile, "Expected Color.cs");
    const content = results[enumFile];
    ok(content.includes("public enum Color"), "Expected enum declaration");
    ok(content.includes('[EnumMember(Value = "red")]'), "Expected red member");
  });

  it("generates a CreateRequest type excluding read-only properties for POST", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read)
        createdAt: utcDateTime;
        name: string;
        count: int32;
      }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) => k.endsWith("ItemCreateRequest.cs"));
    ok(requestFile, "Expected ItemCreateRequest.cs to be emitted");
    const content = results[requestFile];
    ok(content.includes("public record ItemCreateRequest"), "Expected record declaration");
    ok(content.includes("public string Name"), "Expected Name property");
    ok(content.includes("public int Count"), "Expected Count property");
    ok(!content.includes("public string Id"), "Read-only Id should be excluded");
    ok(!content.includes("CreatedAt"), "Read-only createdAt should be excluded");

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile);
    ok(results[ifaceFile].includes("ItemCreateRequest body"), "Interface should reference ItemCreateRequest");
  });

  it("generates an UpdateRequest type excluding read-only and create-only properties for PATCH", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item {
        @visibility(TypeSpec.Lifecycle.Read)
        id: string;
        @visibility(TypeSpec.Lifecycle.Read, TypeSpec.Lifecycle.Create)
        tenantId: string;
        name: string;
      }

      @route("/items")
      interface Items {
        @patch update(@path id: string, @body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) => k.endsWith("ItemUpdateRequest.cs"));
    ok(requestFile, "Expected ItemUpdateRequest.cs to be emitted");
    const content = results[requestFile];
    ok(content.includes("public record ItemUpdateRequest"), "Expected record declaration");
    ok(content.includes("public string Name"), "Expected Name property");
    ok(!content.includes("public string Id"), "Read-only Id should be excluded");
    ok(!content.includes("TenantId"), "Create-only tenantId should be excluded from update");

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile);
    ok(results[ifaceFile].includes("ItemUpdateRequest body"), "Interface should reference ItemUpdateRequest");
  });

  it("does not generate a request type when all properties are writable", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { name: string; count: int32; }

      @route("/items")
      interface Items {
        @post create(@body body: Item): Item;
      }
    `);

    const requestFile = Object.keys(results).find((k) => k.endsWith("ItemCreateRequest.cs"));
    ok(!requestFile, "Should not emit ItemCreateRequest when all properties are writable");

    const ifaceFile = Object.keys(results).find((k) => k.endsWith("IItems.cs"));
    ok(ifaceFile);
    ok(results[ifaceFile].includes("[Body] Item body"), "Interface should use Item directly");
  });
});

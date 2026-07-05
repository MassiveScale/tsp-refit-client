import { strictEqual, ok, match } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./test-host.js";
import { tryParseSemver, toCalVer } from "../src/emitter.js";

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

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs to be emitted");
    const content = results[ifaceFile];
    ok(
      content.includes("public interface IItems"),
      "Expected interface declaration",
    );
    ok(
      content.includes('[Get("/api/items")]'),
      "Expected Get attribute with default route prefix",
    );
    ok(
      content.includes("Task<List<string>>"),
      "Expected Task<List<string>> return type",
    );
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

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes('[Post("/api/items")]'),
      "Expected Post attribute with default route prefix",
    );
    ok(
      content.includes('[Patch("/api/items/{id}")]'),
      "Expected Patch attribute with default route prefix",
    );
    ok(
      content.includes('[Delete("/api/items/{id}")]'),
      "Expected Delete attribute with default route prefix",
    );
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

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("Task RemoveAsync("),
      "Expected bare Task return",
    );
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

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IWidgets.g.cs"),
    );
    ok(ifaceFile);
    const content = results[ifaceFile];
    ok(content.includes("string id"), "Expected string id parameter");
    ok(
      content.includes('[Get("/api/widgets/{id}")]'),
      "Expected path in attribute with default route prefix",
    );
  });

  // ─── route-prefix ────────────────────────────────────────────────────────────

  it("default route-prefix substitutes version value for {version} in versioned APIs", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @service(#{ title: "Test API" })
      @versioned(Versions)
      namespace TestApi;

      enum Versions { v1: "v1.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes('[Get("/api/v1.0/items")]'),
      "Expected {version} replaced with v1.0",
    );
  });

  it("default route-prefix strips {version} for unversioned APIs", async () => {
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

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes('[Get("/api/items")]'),
      "Expected bare api/ prefix for unversioned API",
    );
  });

  it("custom route-prefix is used verbatim without version substitution when no version token", async () => {
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
      { "route-prefix": "v1/api" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes('[Get("/v1/api/items")]'),
      "Expected custom prefix",
    );
  });

  it("trailing slash on route-prefix is normalized — no double slash in emitted path", async () => {
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
      { "route-prefix": "api/" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes('[Get("/api/items")]'),
      "Expected single slash between prefix and path",
    );
    ok(
      !results[ifaceFile].includes("api//items"),
      "Should not produce double slash",
    );
  });

  it("empty route-prefix emits paths as-is", async () => {
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
      { "route-prefix": "" },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes('[Get("/items")]'),
      "Expected original path without prefix",
    );
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

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs to be emitted");
    const content = results[modelFile];
    ok(content.includes("public record Widget"), "Expected record declaration");
    ok(
      content.includes('[JsonPropertyName("name")]'),
      "Expected JsonPropertyName for name",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(
      content.includes('[JsonPropertyName("count")]'),
      "Expected JsonPropertyName for count",
    );
    ok(content.includes("public int Count"), "Expected int Count property");
    ok(content.includes("/// <summary>"), "Expected opening summary tag");
    ok(content.includes("/// A widget."), "Expected doc comment text");
    ok(content.includes("/// </summary>"), "Expected closing summary tag");
    ok(
      content.includes("using System.Text.Json.Serialization"),
      "Expected System.Text.Json.Serialization using",
    );
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
    ok(
      content.includes('<PackageReference Include="Refit"'),
      "Expected Refit reference",
    );
    ok(
      content.includes("<TargetFramework>net8.0</TargetFramework>"),
      "Expected singular TargetFramework for default",
    );
  });

  it("emits TargetFrameworks (plural) when net-version contains multiple TFMs", async () => {
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
      { "net-version": "net8.0;net9.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    const content = results[csproj];
    ok(
      content.includes("<TargetFrameworks>net8.0;net9.0</TargetFrameworks>"),
      "Expected plural TargetFrameworks for multi-target",
    );
    ok(
      !content.includes("<TargetFramework>"),
      "Should not use singular TargetFramework in multi-target mode",
    );
  });

  it("trims whitespace around semicolons in net-version", async () => {
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
      { "net-version": "net8.0 ; net9.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj file");
    ok(
      results[csproj].includes(
        "<TargetFrameworks>net8.0;net9.0</TargetFrameworks>",
      ),
      "Expected whitespace trimmed from TFMs",
    );
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

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("IItems.g.cs"),
    );
    const iItemsFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );

    ok(!v1File, "v1.0 should not be emitted by default");
    ok(
      iItemsFile,
      "Expected IItems.g.cs at root (no version folder in single-version mode)",
    );
    ok(results[iItemsFile!].includes("ListAsync("), "v2 should have ListAsync");
    ok(
      results[iItemsFile!].includes("CreateAsync("),
      "v2 should have CreateAsync",
    );
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
      { "target-version": "v1.0" },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("IItems.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("IItems.g.cs"),
    );
    const iItemsFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );

    ok(!v1File, "No v1.0 folder in single-version mode");
    ok(!v2File, "v2.0 should not be emitted when target-version is v1.0");
    ok(iItemsFile, "Expected IItems.g.cs at root");
    ok(results[iItemsFile!].includes("ListAsync("), "v1 should have ListAsync");
    ok(
      !results[iItemsFile!].includes("CreateAsync("),
      "v1 should not have CreateAsync (added in v2)",
    );
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
      { "all-versions": true },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("IItems.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("IItems.g.cs"),
    );

    ok(v1File, "Expected v1.0/Endpoints/IItems.g.cs");
    ok(v2File, "Expected v2.0/Endpoints/IItems.g.cs");
    ok(results[v1File].includes("ListAsync("), "v1 should have ListAsync");
    ok(
      !results[v1File].includes("CreateAsync("),
      "v1 should not have CreateAsync",
    );
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
      { "target-version": "v9.0" },
    );
    ok(
      diags.some(
        (d) => d.code === "@massivescale/tsp-refit-client/version-not-found",
      ),
      "Expected version-not-found diagnostic",
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

    const enumFile = Object.keys(results).find((k) => k.endsWith("Color.g.cs"));
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

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemCreateRequest.g.cs"),
    );
    ok(requestFile, "Expected ItemCreateRequest.g.cs to be emitted");
    const content = results[requestFile];
    ok(
      content.includes("public record ItemCreateRequest"),
      "Expected record declaration",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(content.includes("public int Count"), "Expected Count property");
    ok(
      !content.includes("public string Id"),
      "Read-only Id should be excluded",
    );
    ok(
      !content.includes("CreatedAt"),
      "Read-only createdAt should be excluded",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("ItemCreateRequest body"),
      "Interface should reference ItemCreateRequest",
    );
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

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemUpdateRequest.g.cs"),
    );
    ok(requestFile, "Expected ItemUpdateRequest.g.cs to be emitted");
    const content = results[requestFile];
    ok(
      content.includes("public record ItemUpdateRequest"),
      "Expected record declaration",
    );
    ok(content.includes("public string Name"), "Expected Name property");
    ok(
      !content.includes("public string Id"),
      "Read-only Id should be excluded",
    );
    ok(
      !content.includes("TenantId"),
      "Create-only tenantId should be excluded from update",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("ItemUpdateRequest body"),
      "Interface should reference ItemUpdateRequest",
    );
  });

  it("uses project-name option for .csproj filename and extensions class", async () => {
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
      { "project-name": "MyAppClient" },
    );

    const csproj = Object.keys(results).find((k) =>
      k.endsWith("MyAppClient.csproj"),
    );
    ok(csproj, "Expected MyAppClient.csproj");

    const extFile = Object.keys(results).find((k) =>
      k.endsWith("MyAppClientExtensions.g.cs"),
    );
    ok(extFile, "Expected MyAppClientExtensions.g.cs");
    const extContent = results[extFile];
    ok(
      extContent.includes("class MyAppClient"),
      "Expected MyAppClient aggregate class",
    );
    ok(
      extContent.includes("class MyAppClientExtensions"),
      "Expected MyAppClientExtensions class",
    );
    ok(extContent.includes("AddMyAppClient"), "Expected AddMyAppClient method");

    const defaultCsproj = Object.keys(results).find((k) =>
      k.endsWith("TestApiClient.csproj"),
    );
    ok(!defaultCsproj, "Default TestApiClient.csproj should not be emitted");
  });

  it("appends version to namespace when version-in-namespace is true in single-version mode", async () => {
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

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "version-in-namespace": true },
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes("namespace TestApi.Client.V2_0"),
      "Expected version in namespace",
    );

    const vFolderFile = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("IItems.g.cs"),
    );
    ok(
      !vFolderFile,
      "Single-version mode should not create version subfolders",
    );
  });

  it("always appends version to namespace with all-versions regardless of version-in-namespace", async () => {
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

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "all-versions": true, "version-in-namespace": false },
    );

    const v1File = Object.keys(results).find(
      (k) => k.includes("v1.0") && k.endsWith("IItems.g.cs"),
    );
    const v2File = Object.keys(results).find(
      (k) => k.includes("v2.0") && k.endsWith("IItems.g.cs"),
    );
    ok(v1File, "Expected v1.0/Endpoints/IItems.g.cs");
    ok(v2File, "Expected v2.0/Endpoints/IItems.g.cs");
    ok(
      results[v1File].includes("namespace TestApi.Client.V1_0"),
      "Expected version in v1 namespace",
    );
    ok(
      results[v2File].includes("namespace TestApi.Client.V2_0"),
      "Expected version in v2 namespace",
    );
  });

  it("emits generic records with correct type parameter and List<T> property type", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Page<T> {
        items: T[];
        total?: int32;
      }

      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Page<Widget>;
      }
    `);

    const pageFile = Object.keys(results).find((k) => k.endsWith("Page.g.cs"));
    ok(pageFile, "Expected Page.g.cs to be emitted");
    const content = results[pageFile];
    ok(
      content.includes("public record Page<T>"),
      "Expected generic record declaration",
    );
    ok(content.includes("public List<T>"), "Expected List<T> property type");
    ok(!content.includes("Array<T>"), "Should not emit Array<T>");
  });

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

  it("uses client-name as default NuGet title", async () => {
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

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Title>PetStore</Title>"),
      "Expected NuGet title from client-name",
    );
  });

  it("nuget-title overrides client-name as NuGet title", async () => {
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
      { "client-name": "PetStore", "nuget-title": "My Pet Store Client" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Title>My Pet Store Client</Title>"),
      "Expected explicit nuget-title",
    );
    ok(
      !results[csproj].includes("<Title>PetStore</Title>"),
      "client-name should not appear as title",
    );
  });

  it("emits NuGet package properties when provided", async () => {
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
      {
        "nuget-package-id": "Acme.PetStore.Client",
        "nuget-version": "2.0.0",
        "nuget-authors": "Acme Corp",
        "nuget-description": "Client library for the Acme Pet Store API.",
        "nuget-tags": "refit petstore api",
      },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    const content = results[csproj];
    ok(
      content.includes("<PackageId>Acme.PetStore.Client</PackageId>"),
      "Expected PackageId",
    );
    ok(content.includes("<Version>2.0.0</Version>"), "Expected Version");
    ok(content.includes("<Authors>Acme Corp</Authors>"), "Expected Authors");
    ok(
      content.includes(
        "<Description>Client library for the Acme Pet Store API.</Description>",
      ),
      "Expected Description",
    );
    ok(
      content.includes("<PackageTags>refit petstore api</PackageTags>"),
      "Expected PackageTags",
    );
  });

  it("emits </PropertyGroup> at 2-space indent matching <PropertyGroup>", async () => {
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
      { "nuget-version": "1.0.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    const content = results[csproj];
    ok(
      content.includes("  </PropertyGroup>"),
      "Expected 2-space-indented </PropertyGroup>",
    );
    ok(
      !content.includes("    </PropertyGroup>"),
      "Should not have 4-space-indented </PropertyGroup>",
    );
  });

  it("does not emit NuGet title when neither client-name nor nuget-title is set", async () => {
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
    ok(csproj, "Expected .csproj");
    ok(
      !results[csproj].includes("<Title>"),
      "Title should not be emitted by default",
    );
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

    const requestFile = Object.keys(results).find((k) =>
      k.endsWith("ItemCreateRequest.g.cs"),
    );
    ok(
      !requestFile,
      "Should not emit ItemCreateRequest when all properties are writable",
    );

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile);
    ok(
      results[ifaceFile].includes("[Body] Item body"),
      "Interface should use Item directly",
    );
  });

  // ─── Aggregate client ────────────────────────────────────────────────────────

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
      content.includes("Pets = pets;"),
      "Expected Pets assignment in constructor",
    );
    ok(
      content.includes("Stores = stores;"),
      "Expected Stores assignment in constructor",
    );
    ok(
      content.includes("AddTransient<TestApiClient>()"),
      "Expected aggregate client registered as transient",
    );
    ok(content.includes("AddSingleClient<IPets>"), "Expected IPets registered");
    ok(
      content.includes("AddSingleClient<IStores>"),
      "Expected IStores registered",
    );
  });

  // ─── NuGet version derivation ─────────────────────────────────────────────

  describe("tryParseSemver", () => {
    it("parses two-part version", () =>
      strictEqual(tryParseSemver("1.2"), "1.2.0"));
    it("parses three-part version", () =>
      strictEqual(tryParseSemver("1.2.3"), "1.2.3"));
    it("strips leading v", () => strictEqual(tryParseSemver("v2.1"), "2.1.0"));
    it("strips leading V", () =>
      strictEqual(tryParseSemver("V3.0.1"), "3.0.1"));
    it("preserves pre-release suffix", () =>
      strictEqual(tryParseSemver("v2.0-preview"), "2.0.0-preview"));
    it("preserves rc suffix", () =>
      strictEqual(tryParseSemver("1.0.0-rc.1"), "1.0.0-rc.1"));
    it("returns undefined for single-digit", () =>
      strictEqual(tryParseSemver("v1"), undefined));
    it("returns undefined for date-style string", () =>
      strictEqual(tryParseSemver("2022-10-15"), undefined));
    it("returns undefined for plain label", () =>
      strictEqual(tryParseSemver("preview"), undefined));
  });

  describe("toCalVer", () => {
    it("formats as YYYY.MM.DD", () => {
      strictEqual(toCalVer(new Date(2026, 4, 21)), "2026.05.21");
    });
    it("zero-pads month and day", () => {
      strictEqual(toCalVer(new Date(2026, 0, 3)), "2026.01.03");
    });
  });

  it("uses semver parsed from TypeSpec API version as NuGet version", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v2_1: "v2.1" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>2.1.0</Version>"),
      "Expected semver derived from TypeSpec version",
    );
  });

  it("falls back to CalVer when TypeSpec version is not semver-parseable", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { sprint42: "sprint-42" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    match(
      results[csproj],
      /<Version>\d{4}\.\d{2}\.\d{2}<\/Version>/,
      "Expected CalVer fallback",
    );
  });

  it("falls back to CalVer for unversioned API", async () => {
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
    ok(csproj, "Expected .csproj");
    match(
      results[csproj],
      /<Version>\d{4}\.\d{2}\.\d{2}<\/Version>/,
      "Expected CalVer for unversioned API",
    );
  });

  it("uses target-version semver when target-version is specified", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v1_0: "v1.0", v2_0: "v2.0" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "target-version": "v1.0" },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>1.0.0</Version>"),
      "Expected version from target-version",
    );
    ok(
      !results[csproj].includes("<Version>2.0.0</Version>"),
      "Should not use latest when target-version is set",
    );
  });

  it("uses latest version semver when all-versions is true", async () => {
    const results = await emit(
      `
      import "@typespec/http";
      import "@typespec/versioning";
      using Http;
      using Versioning;

      @versioned(Versions)
      @service(#{ title: "Test API" })
      namespace TestApi;

      enum Versions { v1_0: "v1.0", v3_2: "v3.2" }

      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `,
      { "all-versions": true },
    );

    const csproj = Object.keys(results).find((k) => k.endsWith(".csproj"));
    ok(csproj, "Expected .csproj");
    ok(
      results[csproj].includes("<Version>3.2.0</Version>"),
      "Expected latest version semver with all-versions",
    );
  });

  // ─── Multi-line doc comment rendering ────────────────────────────────────────

  it("emits all lines of a multi-line model doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("First line.\\nSecond line.")
      model Widget {
        @doc("Prop first.\\nProp second.")
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    const content = results[modelFile];
    ok(
      content.includes("/// First line."),
      "Expected first doc line on record",
    );
    ok(
      content.includes("/// Second line."),
      "Expected second doc line on record",
    );
    ok(
      !content.includes("Second line.") ||
        content.split("/// Second line.").length >= 2,
      "Second line must always start with ///",
    );
    ok(
      content.includes("/// Prop first."),
      "Expected first doc line on property",
    );
    ok(
      content.includes("/// Prop second."),
      "Expected second doc line on property",
    );
  });

  it("emits all lines of a multi-line enum doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @doc("Enum first.\\nEnum second.")
      enum Status {
        @doc("Member first.\\nMember second.")
        Active: "active",
      }

      model Item { status: Status; }

      @route("/items")
      interface Items {
        @get list(): Item[];
      }
    `);

    const enumFile = Object.keys(results).find((k) =>
      k.endsWith("Status.g.cs"),
    );
    ok(enumFile, "Expected Status.g.cs");
    const content = results[enumFile];
    ok(content.includes("/// Enum first."), "Expected first enum doc line");
    ok(content.includes("/// Enum second."), "Expected second enum doc line");
    ok(content.includes("/// Member first."), "Expected first member doc line");
    ok(
      content.includes("/// Member second."),
      "Expected second member doc line",
    );
  });

  it("emits all lines of a multi-line operation doc with /// prefix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @doc("Op first.\\nOp second.")
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    ok(content.includes("/// Op first."), "Expected first op doc line");
    ok(content.includes("/// Op second."), "Expected second op doc line");
  });

  // ─── Optional / nullable parameters ──────────────────────────────────────────

  it("emits optional query params as nullable with default null", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(@query skip?: int32, @query take?: int32): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes("int? skip = null"),
      "Expected optional skip as int? with default null",
    );
    ok(
      content.includes("int? take = null"),
      "Expected optional take as int? with default null",
    );
  });

  it("emits required query params without nullable suffix", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @get list(@query filter: string): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    ok(
      content.includes("string filter"),
      "Expected required filter as plain string",
    );
    ok(
      !content.includes("string? filter"),
      "Required param should not be nullable",
    );
    ok(
      !content.includes("string filter = null"),
      "Required param should not have null default",
    );
  });

  it("places optional params after required ones when mixed", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { name: string; }

      @route("/stores/{storeId}/items")
      interface Items {
        @post create(@path storeId: string, @query dryRun?: boolean, @body body: Item): Item;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    const methodLine = content
      .split("\n")
      .find((l) => l.includes("CreateAsync("));
    ok(methodLine, "Expected CreateAsync method");
    const skipIdx = methodLine!.indexOf("storeId");
    const bodyIdx = methodLine!.indexOf("[Body]");
    const dryRunIdx = methodLine!.indexOf("dryRun");
    ok(
      skipIdx < bodyIdx,
      "Required path param storeId must come before required body",
    );
    ok(bodyIdx < dryRunIdx, "Required body must come before optional dryRun");
    ok(
      content.includes("bool? dryRun = null"),
      "Expected dryRun as bool? with default null",
    );
  });

  // ─── @clientName ─────────────────────────────────────────────────────────────

  it("@clientName on a model property uses the TypeSpec name as [JsonPropertyName]", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Widget {
        @clientName("CorrelationIdentifier")
        traceId: string;
      }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    const content = results[modelFile];
    ok(
      content.includes('[JsonPropertyName("traceId")]'),
      "Expected JsonPropertyName to use original TypeSpec name",
    );
    ok(
      content.includes("public string CorrelationIdentifier"),
      "Expected C# property to use @clientName override",
    );
  });

  it("@clientName on a model overrides the emitted record name and file name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Pet")
      model Animal { id: string; }

      @route("/animals")
      interface Animals {
        @get list(): Animal[];
      }
    `);

    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs (clientName override)");
    ok(
      results[petFile].includes("public record Pet"),
      "Expected record name Pet",
    );
    const animalFile = Object.keys(results).find((k) =>
      k.endsWith("Animal.g.cs"),
    );
    ok(!animalFile, "Animal.g.cs should not exist when clientName is Pet");

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IAnimals.g.cs"),
    );
    ok(ifaceFile, "Expected IAnimals.g.cs");
    ok(
      results[ifaceFile].includes("Task<List<Pet>>"),
      "Expected Pet type reference in interface",
    );
  });

  it("@clientName on an enum overrides the emitted enum name and file name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Color")
      enum Colour { red, green, blue }

      model Widget { color: Colour; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const colorFile = Object.keys(results).find((k) =>
      k.endsWith("Color.g.cs"),
    );
    ok(colorFile, "Expected Color.g.cs (clientName override)");
    ok(
      results[colorFile].includes("public enum Color"),
      "Expected enum name Color",
    );
    const colourFile = Object.keys(results).find((k) =>
      k.endsWith("Colour.g.cs"),
    );
    ok(!colourFile, "Colour.g.cs should not exist when clientName is Color");
  });

  it("@clientName on an interface overrides the C# interface name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Widgets")
      @route("/things")
      interface Things {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IWidgets.g.cs"),
    );
    ok(ifaceFile, "Expected IWidgets.g.cs (clientName override)");
    ok(
      results[ifaceFile].includes("public interface IWidgets"),
      "Expected interface named IWidgets",
    );
    const thingsFile = Object.keys(results).find((k) =>
      k.endsWith("IThings.g.cs"),
    );
    ok(!thingsFile, "IThings.g.cs should not exist when clientName is Widgets");
  });

  it("@clientName on an operation overrides the C# method name", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @route("/items")
      interface Items {
        @clientName("search")
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    ok(content.includes("SearchAsync("), "Expected SearchAsync method name");
    ok(!content.includes("ListAsync("), "ListAsync should not appear");
  });

  it("reports an error for empty or whitespace @clientName values", async () => {
    const [, diags] = await emitWithDiagnostics(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("   ")
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    ok(
      diags.some(
        (d) => d.code === "@massivescale/tsp-refit-client/invalid-client-name",
      ),
      "Expected invalid-client-name diagnostic",
    );
  });

  it("reports an error when model and enum collide on output file name", async () => {
    const [, diags] = await emitWithDiagnostics(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @clientName("Shared")
      model Animal {
        id: string;
        color: Colour;
      }

      @clientName("Shared")
      enum Colour { red }

      @route("/animals")
      interface Animals {
        @get list(): Animal[];
      }
    `);

    ok(
      diags.some(
        (d) =>
          d.code === "@massivescale/tsp-refit-client/output-name-collision",
      ),
      "Expected output-name-collision diagnostic",
    );
  });

  // ─── @access ─────────────────────────────────────────────────────────────────

  it("@access(Access.internal) on a model emits internal record", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    ok(
      results[modelFile].includes("internal record Widget"),
      "Expected internal record",
    );
    ok(
      !results[modelFile].includes("public record Widget"),
      "Should not contain public record",
    );
  });

  it("@access(Access.internal) on an enum emits internal enum", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      enum Status { active, inactive }

      model Widget { status: Status; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const enumFile = Object.keys(results).find((k) =>
      k.endsWith("Status.g.cs"),
    );
    ok(enumFile, "Expected Status.g.cs");
    ok(
      results[enumFile].includes("internal enum Status"),
      "Expected internal enum",
    );
    ok(
      !results[enumFile].includes("public enum Status"),
      "Should not contain public enum",
    );
  });

  it("@access(Access.internal) on an interface emits internal interface", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.internal)
      @route("/items")
      interface Items {
        @get list(): string[];
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    ok(
      results[ifaceFile].includes("internal interface IItems"),
      "Expected internal interface",
    );
    ok(
      !results[ifaceFile].includes("public interface IItems"),
      "Should not contain public interface",
    );
  });

  it("@access(Access.public) explicitly keeps public modifier", async () => {
    const results = await emit(`
      import "@typespec/http";
      import "@massivescale/tsp-refit-client";
      using Http;
      using MassiveScale.TspRefitClient;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @access(Access.public)
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get list(): Widget[];
      }
    `);

    const modelFile = Object.keys(results).find((k) =>
      k.endsWith("Widget.g.cs"),
    );
    ok(modelFile, "Expected Widget.g.cs");
    ok(
      results[modelFile].includes("public record Widget"),
      "Expected public record when Access.public is explicit",
    );
  });

  // ─── clean-output-dir ────────────────────────────────────────────────────────

  it("clean-output-dir: false is accepted without diagnostics", async () => {
    const [, diags] = await emitWithDiagnostics(
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
      { "clean-output-dir": false },
    );
    strictEqual(diags.length, 0, "Expected no diagnostics");
  });

  it("clean-output-dir: true is accepted without diagnostics", async () => {
    const [, diags] = await emitWithDiagnostics(
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
      { "clean-output-dir": true },
    );
    strictEqual(diags.length, 0, "Expected no diagnostics");
  });

  // ─── @discriminator ─────────────────────────────────────────────────────────

  const DISCRIMINATOR_SPEC = `
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @discriminator("kind")
      model Pet {
        kind: string;
        name: string;
      }

      model Dog extends Pet {
        kind: "dog";
        isBarker: boolean;
      }

      model Cat extends Pet {
        kind: "cat";
        isPurrer: boolean;
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `;

  it("emits [JsonPolymorphic] and one [JsonDerivedType] per derived model on the base record", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    const content = results[petFile];
    ok(
      content.includes(
        '[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]',
      ),
      "Expected JsonPolymorphic attribute using the discriminator's wire name",
    );
    ok(
      content.includes('[JsonDerivedType(typeof(Dog), "dog")]'),
      "Expected JsonDerivedType for Dog",
    );
    ok(
      content.includes('[JsonDerivedType(typeof(Cat), "cat")]'),
      "Expected JsonDerivedType for Cat",
    );
  });

  it("emits derived models as records inheriting the base record, without redeclaring the discriminator property", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const dogFile = Object.keys(results).find((k) => k.endsWith("Dog.g.cs"));
    ok(
      dogFile,
      "Expected Dog.g.cs to be emitted even though nothing references Dog directly",
    );
    const content = results[dogFile];
    ok(
      content.includes("public record Dog : Pet"),
      "Expected Dog to inherit from Pet in C#",
    );
    ok(
      !content.includes("Kind"),
      "Discriminator property should not be redeclared on the derived record",
    );
    ok(
      content.includes("public bool IsBarker"),
      "Expected Dog's own property to still be emitted",
    );
  });

  it("emits a sibling derived model (Cat) that is never referenced directly", async () => {
    const results = await emit(DISCRIMINATOR_SPEC);
    const catFile = Object.keys(results).find((k) => k.endsWith("Cat.g.cs"));
    ok(catFile, "Expected Cat.g.cs to be emitted");
    ok(
      results[catFile].includes("public record Cat : Pet"),
      "Expected Cat to inherit from Pet in C#",
    );
  });

  it("discovers grandchild variants through an intermediate model with no @discriminator of its own", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      @discriminator("kind")
      model Pet {
        kind: string;
      }

      // Dog is a pass-through: no own discriminator value, just a grouping type.
      model Dog extends Pet {}

      model Labrador extends Dog {
        kind: "labrador";
        isGoodBoy: boolean;
      }

      model Poodle extends Dog {
        kind: "poodle";
        isFancy: boolean;
      }

      @route("/pets")
      interface Pets {
        @get list(): Pet[];
      }
    `);

    const dogFile = Object.keys(results).find((k) => k.endsWith("Dog.g.cs"));
    ok(dogFile, "Expected Dog.g.cs to be emitted");
    ok(
      results[dogFile].includes("public record Dog : Pet"),
      "Expected Dog to inherit from Pet in C#",
    );

    const labradorFile = Object.keys(results).find((k) =>
      k.endsWith("Labrador.g.cs"),
    );
    ok(
      labradorFile,
      "Expected Labrador.g.cs to be emitted despite Dog (its parent) lacking its own @discriminator",
    );
    ok(
      results[labradorFile].includes("public record Labrador : Dog"),
      "Expected Labrador to inherit from Dog in C#",
    );

    const poodleFile = Object.keys(results).find((k) =>
      k.endsWith("Poodle.g.cs"),
    );
    ok(poodleFile, "Expected Poodle.g.cs to be emitted");

    const petFile = Object.keys(results).find((k) => k.endsWith("Pet.g.cs"));
    ok(petFile, "Expected Pet.g.cs");
    ok(
      results[petFile].includes(
        '[JsonDerivedType(typeof(Labrador), "labrador")]',
      ),
      "Expected JsonDerivedType for the grandchild Labrador on the root Pet record",
    );
    ok(
      results[petFile].includes('[JsonDerivedType(typeof(Poodle), "poodle")]'),
      "Expected JsonDerivedType for the grandchild Poodle on the root Pet record",
    );
  });

  // ─── additional query parameters ─────────────────────────────────────────────

  it("adds an additionalQueryParameters dictionary parameter to every generated method", async () => {
    const results = await emit(`
      import "@typespec/http";
      using Http;

      @service(#{ title: "Test API" })
      namespace TestApi;

      model Item { id: string; name: string; }

      @route("/items")
      interface Items {
        @get list(@query skip?: int32): Item[];
        @post create(@body body: Item): Item;
        @delete remove(@path id: string): void;
      }
    `);

    const ifaceFile = Object.keys(results).find((k) =>
      k.endsWith("IItems.g.cs"),
    );
    ok(ifaceFile, "Expected IItems.g.cs");
    const content = results[ifaceFile];
    const expected =
      "[Query] Dictionary<string, object>? additionalQueryParameters = null";
    ok(
      content.includes(
        `ListAsync(int? skip = null, ${expected}, CancellationToken`,
      ),
      "Expected additionalQueryParameters on ListAsync, after existing optional params",
    );
    ok(
      content.includes(
        `CreateAsync([Body] Item body, ${expected}, CancellationToken`,
      ),
      "Expected additionalQueryParameters on CreateAsync, which has no query params of its own",
    );
    ok(
      content.includes(`RemoveAsync(string id, ${expected}, CancellationToken`),
      "Expected additionalQueryParameters on RemoveAsync, a DELETE with no body",
    );
  });
});

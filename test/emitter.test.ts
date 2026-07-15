import { strictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { emit, emitWithDiagnostics } from "./host.js";

describe("emitter", () => {
  it("emits nothing for an operation with no HTTP service", async () => {
    const results = await emit(`op test(): void;`);
    strictEqual(Object.keys(results).length, 0);
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
});

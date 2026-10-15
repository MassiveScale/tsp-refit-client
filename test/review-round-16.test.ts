import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { buildExtensions } from "../src/client.js";
import { createRenderer } from "../src/renderer.js";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

/** The constructor parameter list of the aggregate client. */
const constructorParameters = (extensions: string): string =>
  /public TestApiClient\(([^)]*)\)/.exec(extensions)?.[1] ??
  /internal TestApiClient\(([^)]*)\)/.exec(extensions)?.[1] ??
  "";

describe("aggregate client constructor parameters", () => {
  it("sets a property that shares its parameter's name through this", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface items { @get read(): void; }
    `);

    const extensions = fileContent(results, "TestApiClientExtensions.g.cs");
    const parameters = constructorParameters(extensions);
    ok(parameters.includes("Iitems items"), parameters);
    // The property `items` is set through `this`, since the parameter of the same
    // name would otherwise be the one assigned.
    ok(
      extensions.includes(
        "this.items = items ?? throw new ArgumentNullException(nameof(items));",
      ),
      extensions,
    );
  });

  it("gives endpoints whose names differ only in their first letter different parameter names", () => {
    // Two such interfaces are reported as a file-name clash by the emitter, so the
    // builder is called directly.
    const parameters = constructorParameters(
      buildExtensions(
        "TestApiClient",
        "TestApi",
        [
          { interfaceName: "IItems", access: "public" },
          { interfaceName: "Iitems", access: "public" },
        ],
        createRenderer(),
      ),
    );
    ok(parameters.includes("IItems items"), parameters);
    ok(parameters.includes("Iitems itemsEndpoint"), parameters);
  });

  it("documents an escaped parameter by its unescaped name", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/a") interface Params { @get read(): void; }
    `);

    const extensions = fileContent(results, "TestApiClientExtensions.g.cs");
    ok(extensions.includes("IParams @params"), extensions);
    ok(extensions.includes('<param name="params">'), extensions);
    ok(!extensions.includes('<param name="@params">'), extensions);
  });
});

describe("the aggregate client file", () => {
  it("declares a lower-case client name verbatim (CS8981)", async () => {
    const results = await emit(
      `${PREAMBLE} @route("/a") interface Items { @get read(): void; }`,
      { "client-name": "petstore" },
    );

    const extensions = fileContent(results, "petstoreExtensions.g.cs");
    ok(extensions.includes("public class @petstore"), extensions);
  });

  it("applies additional-usings like every other file", async () => {
    const results = await emit(
      `${PREAMBLE} @route("/a") interface Items { @get read(): void; }`,
      { "additional-usings": ["Acme.Shared"] },
    );

    ok(
      fileContent(results, "TestApiClientExtensions.g.cs").includes(
        "using Acme.Shared;",
      ),
    );
  });
});

describe("enum members that share a wire value", () => {
  for (const [kind, members, arm] of [
    ["string", `first: "x", second: "x", third: "y"`, `"x" =>`],
    ["number", `first: 1, second: 1, third: 2`, `1L =>`],
  ]) {
    it(`reads a shared ${kind} value as the first member, and writes each`, async () => {
      const results = await emit(`${PREAMBLE}
        enum Shared { ${members} }
        @route("/s") interface Things { @get read(@query v: Shared): Shared; }
      `);

      const source = fileContent(results, "/Shared.g.cs");
      strictEqual(source.split(arm).length - 1, 1, source);
      ok(source.includes(`${arm} Shared.First`), source);
      ok(source.includes("case Shared.Second:"), source);
      ok(source.includes("Second,"), source);
    });
  }
});

describe("dictionary request bodies", () => {
  const SPEC = `${PREAMBLE}
    model Widget { @visibility(Lifecycle.Read) id: string; name: string; }
  `;

  it("send the request record as the dictionary's values", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Record<Widget>): Record<Widget>; }
    `);

    const iface = fileContent(results, "IWidgets.g.cs");
    ok(
      iface.includes(
        "Task<Dictionary<string, Widget>> CreateAsync([Body(BodySerializationMethod.Serialized, true)] Dictionary<string, WidgetCreateRequest> body,",
      ),
      iface,
    );
    strictEqual((iface.match(/Task.*CreateAsync\(/g) ?? []).length, 1, iface);
  });

  it("look through lists and nullables to the dictionary", async () => {
    const results = await emit(`${SPEC}
      @route("/w") interface Widgets { @post create(@body body: Record<Widget>[] | null): void; }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "CreateAsync([Body(BodySerializationMethod.Serialized, true)] List<Dictionary<string, WidgetCreateRequest>>? body,",
      ),
    );
  });
});

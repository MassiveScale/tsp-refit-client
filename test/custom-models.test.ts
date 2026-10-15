import { ok, match, doesNotMatch, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emit, fileContent } from "./host.js";

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Test API" })
  namespace TestApi;
`;

describe("response types", () => {
  for (const [label, returnType, expected] of [
    ["a model", "Widget", "Task<Widget> ReadAsync("],
    ["a list of models", "Widget[]", "Task<List<Widget>> ReadAsync("],
    [
      "a dictionary of models",
      "Record<Widget>",
      "Task<Dictionary<string, Widget>> ReadAsync(",
    ],
    [
      "nested lists of models",
      "Widget[][]",
      "Task<List<List<Widget>>> ReadAsync(",
    ],
    ["a template instance", "Page<Widget>", "Task<Page<Widget>> ReadAsync("],
    ["a discriminated base", "Pet[]", "Task<List<Pet>> ReadAsync("],
  ] as const) {
    it(`declares one method returning ${label}, with no generic overload`, async () => {
      const results = await emit(`${PREAMBLE}
        model Widget { id: string; }
        model Page<T> { items: T[]; }
        @discriminator("kind") model Pet { kind: string; name: string; }
        model Dog extends Pet { kind: "dog"; }

        @route("/things")
        interface Things {
          @get read(): ${returnType};
        }
      `);

      const iface = fileContent(results, "IThings.g.cs");
      ok(iface.includes(expected), `Expected ${expected}`);
      doesNotMatch(iface, /<TResult>|where TResult/);
    });
  }
});

describe("request body parameters", () => {
  it("takes a collection of models as a List", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("bulk") @post createMany(@body body: Widget[]): Widget[];
      }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "CreateManyAsync([Body(BodySerializationMethod.Serialized, true)] List<Widget> body,",
      ),
    );
  });

  it("takes a dictionary of models as a Dictionary", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("bulk") @post createMany(@body body: Record<Widget>): void;
      }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "CreateManyAsync([Body(BodySerializationMethod.Serialized, true)] Dictionary<string, Widget> body,",
      ),
    );
  });

  it("takes nested collections of models as nested Lists", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @route("grid") @post createGrid(@body body: Widget[][]): void;
      }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "CreateGridAsync([Body(BodySerializationMethod.Serialized, true)] List<List<Widget>> body,",
      ),
    );
  });

  it("takes a collection of scalars as a List", async () => {
    const results = await emit(`${PREAMBLE}
      @route("/tags")
      interface Tags {
        @post add(@body body: string[]): void;
      }
    `);

    ok(
      fileContent(results, "ITags.g.cs").includes(
        "AddAsync([Body(BodySerializationMethod.Serialized, true)] List<string> body,",
      ),
    );
  });

  it("takes a single model as the model itself", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @put replace(@path id: string, @body body: Widget): Widget;
      }
    `);

    ok(
      fileContent(results, "IWidgets.g.cs").includes(
        "ReplaceAsync(string id, [Body(BodySerializationMethod.Serialized, true)] Widget body,",
      ),
    );
  });

  it("takes a merge patch as IMergePatch", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; name: string; }

      @route("/widgets")
      interface Widgets {
        @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
      }
    `);

    const iface = fileContent(results, "IWidgets.g.cs");
    ok(
      iface.includes(
        "UpdateAsync(string id, [Body(BodySerializationMethod.Serialized, true)] IMergePatch<Widget> body,",
      ),
    );
    ok(
      iface.includes('[Headers("Content-Type: application/merge-patch+json")]'),
    );
    ok(
      !iface.includes(" MergePatch<"),
      "Expected the interface, not the class",
    );
  });
});

describe("derived models and records", () => {
  it("emits records that can be derived from", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget { id: string; }

      @route("/widgets")
      interface Widgets {
        @get read(): Widget;
      }
    `);

    const widget = fileContent(results, "Widget.g.cs");
    ok(widget.includes("public record Widget"));
    doesNotMatch(widget, /sealed/);
  });

  it("emits request records that can be derived from", async () => {
    const results = await emit(`${PREAMBLE}
      model Widget {
        @visibility(Lifecycle.Read) id: string;
        name: string;
      }

      @route("/widgets")
      interface Widgets {
        @post create(@body body: Widget): Widget;
      }
    `);

    const iface = fileContent(results, "IWidgets.g.cs");
    ok(
      iface.includes(
        "Task<Widget> CreateAsync([Body(BodySerializationMethod.Serialized, true)] WidgetCreateRequest body,",
      ),
    );
    const request = fileContent(results, "WidgetCreateRequest.g.cs");
    match(request, /public record WidgetCreateRequest/);
    doesNotMatch(request, /sealed/);
  });

  it("registers discriminated subtypes so they round-trip through the base", async () => {
    const results = await emit(`${PREAMBLE}
      @discriminator("kind")
      model Pet { kind: string; name: string; }
      model Dog extends Pet { kind: "dog"; }
      model Cat extends Pet { kind: "cat"; }

      @route("/pets")
      interface Pets {
        @get read(): Pet;
      }
    `);

    const pet = fileContent(results, "Pet.g.cs");
    ok(pet.includes('[JsonDerivedType(typeof(Dog), "dog")]'));
    ok(pet.includes('[JsonDerivedType(typeof(Cat), "cat")]'));
    strictEqual(
      Object.keys(results).filter((k) => /\/(Dog|Cat)\.g\.cs$/.test(k)).length,
      2,
    );
  });
});

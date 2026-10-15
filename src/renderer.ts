/**
 * @module renderer
 *
 * Handlebars-based template renderer for C# Refit client code generation.
 *
 * Provides view-model types that carry structured data from the emitter to the
 * templates, and a factory (`createRenderer`) that compiles all templates once
 * and returns a stateless {@link Renderer}.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";
import { csDeclarationName } from "./utils.js";
import { fx, qualifyTemplate, type FrameworkUse } from "./framework.js";

/** Absolute path to the bundled default templates directory. */
const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates",
);

/**
 * Names of the built-in Handlebars templates.
 * Each name maps to a `<name>.hbs` file inside {@link TEMPLATES_DIR}.
 */
export type TemplateName =
  | "file"
  | "record"
  | "enum"
  | "refit-interface"
  | "csproj"
  | "extensions"
  | "merge-patch"
  | "client-runtime";

/**
 * Partial map of template names to absolute file paths used to override the
 * built-in defaults. Any template not listed falls back to its bundled counterpart.
 */
export type TemplateOverrides = Partial<Record<TemplateName, string>>;

/** View model for a single C# property declaration inside a record. */
export interface PropertyView {
  /** Optional XML doc text (pre-escaped). Rendered as `/// <summary>...</summary>`. */
  doc?: string;
  /** The wire name, XML-escaped, used for the generated summary when {@link doc} is absent. */
  docName: string;
  /** Full C# type including optional `?`, e.g. `"string"`, `"int?"`, `"List<Pet>"`. */
  type: string;
  /** PascalCase property name. */
  name: string;
  /** JSON wire name written to `[JsonPropertyName("...")]`, e.g. `"firstName"`. Always the original TypeSpec property name. */
  jsonPropertyName: string;
  /** Default initializer expression (without `= ` and `;`), e.g. `"default!"`, `"[]"`. */
  defaultValue?: string;
  /** `true` for a number that travels as a JSON string (`@encode("string")`); adds `[JsonNumberHandling(...)]`. */
  numberAsString?: boolean;
  /**
   * `true` for a required property whose type allows null (`note: string | null`);
   * adds `[JsonIgnore(Condition = JsonIgnoreCondition.Never)]`, so a null is sent as
   * `"note": null` instead of being left out the way an optional property is.
   */
  writeNull?: boolean;
  /**
   * The `[JsonConverter]` type for a property with an `@encode` the runtime
   * implements, e.g. `ClientRuntime.UnixSecondsConverter`.
   */
  converter?: string;
}

/** One derived-type entry for a `[JsonDerivedType(typeof(...), "...")]` attribute. */
export interface DerivedTypeView {
  /** C# record name of the derived type, e.g. `"Dog"`. */
  typeName: string;
  /** Wire discriminator value, e.g. `"dog"`. */
  value: string;
}

/** View model describing `@discriminator` polymorphism for a base record. */
export interface DiscriminatorView {
  /** JSON wire name of the discriminator property, e.g. `"petKind"`. */
  propertyName: string;
  /** Ordered list of known derived types, keyed by their discriminator value. */
  derivedTypes: DerivedTypeView[];
}

/** View model for a C# `public record` declaration. */
export interface RecordView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase record name, e.g. `"Widget"` or `"PetCreateRequest"`. */
  recordName: string;
  /** Generic parameter string, e.g. `"<T>"` or `""` for non-generic records. */
  genericSuffix: string;
  /** Ordered list of property view models. */
  properties: PropertyView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
  /** C# record name to inherit from (`: {baseRecordName}`), when this record is part of a `@discriminator` hierarchy. */
  baseRecordName?: string;
  /** Present when the decorated model declares `@discriminator`; drives `[JsonPolymorphic]` / `[JsonDerivedType]` attributes. */
  discriminator?: DiscriminatorView;
  /** When true, emits the `abstract` modifier — set for `@discriminator` hierarchy members with no concrete wire shape of their own. */
  isAbstract?: boolean;
}

/** View model for a single C# enum member. */
export interface EnumMemberView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** The declared value in text form, XML-escaped, used for the generated summary when {@link doc} is absent. */
  docValue: string;
  /** PascalCase member name. */
  name: string;
  /**
   * Text form of the declared value, for `[EnumMember(Value = "...")]` and, for a
   * string member, the wire string. Escaped for a C# string literal.
   */
  memberValue: string;
  /**
   * The C# numeric literal (`"1L"`, `"1.5D"`) when the member was declared with a
   * number, so it travels as a JSON number. Absent for a string member.
   */
  numberLiteral?: string;
  /**
   * Whether reading the member's wire value gives this member: the first member
   * declared with that value. A later member with the same value (an alias) still
   * writes it, but is never read.
   */
  reads: boolean;
}

/** View model for a C# `public enum` declaration. */
export interface EnumView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase enum name. */
  enumName: string;
  /** Ordered list of enum member view models. */
  members: EnumMemberView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
  /** Whether any member is declared as a string. */
  hasStringMembers: boolean;
  /** Whether any member is declared as a number. */
  hasNumberMembers: boolean;
  /** What a reader may find for this enum, for the error message: `"a string"`, `"a number"`, or both. */
  expectedToken: string;
}

/**
 * How a request or response payload travels on the wire: JSON, raw bytes, plain
 * text, or (for a response declared as both JSON and text) whichever the server's
 * `Content-Type` says arrived.
 */
export type PayloadKind = "json" | "bytes" | "text" | "negotiated";

/** View model for a single Refit interface method. */
export interface MethodView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** Method name, e.g. `"ListAsync"`. */
  methodName: string;
  /** PascalCase Refit verb attribute, e.g. `"Get"`, `"Post"`. */
  httpMethod: string;
  /** Route path, escaped for a C# string literal, e.g. `"/api/widgets/{id}"`. */
  route: string;
  /** Static headers for a `[Headers(...)]` attribute, each escaped for a C# string literal, e.g. `"Content-Type: text/plain"`. */
  headers: string[];
  /** Further method attributes without brackets, e.g. `"ClientRuntime.EmptyStatus(204)"`. */
  attributes: string[];
  /** Attributes on the return value without brackets, e.g. a response `@encode`. */
  returnAttributes: string[];
  /** C# return type, e.g. `"Task<Widget>"` or `"Task"`. */
  returnType: string;
  /** Pre-rendered comma-separated parameter list, attributes included. */
  paramsText: string;
}

/** View model for a Refit `public interface` declaration. */
export interface RefitInterfaceView {
  /** C# interface name, e.g. `"IWidgets"`. */
  interfaceName: string;
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** Ordered list of method view models. */
  methods: MethodView[];
  /** C# access modifier: `"public"` (default) or `"internal"`. */
  access: string;
}
/** View model passed to the `file` template — wraps any inner body with the file header. */
export interface FileView {
  /** Fully-qualified C# namespace string. */
  namespace: string;
  /** Sorted list of `using` directive namespaces (without the `using` keyword). */
  usings: string[];
  /** Pre-rendered inner declaration body. */
  body: string;
  /** Basename of the file being emitted, e.g. `"Widget.cs"`. */
  fileName: string;
}

/** One Refit interface entry used in the aggregate client and DI registration. */
export interface InterfaceEntry {
  /** C# interface name, e.g. `"IStores"`. */
  name: string;
  /** Property name on the aggregate client class, e.g. `"Stores"`. */
  propertyName: string;
  /** Constructor parameter name as written in C#, verbatim-escaped when needed, e.g. `"stores"` or `"@params"`. */
  paramName: string;
  /** The parameter name in its XML documentation, never escaped, e.g. `"params"`. */
  docParamName: string;
  /** C# access modifier of the property: the interface's own, `"public"` or `"internal"`. */
  access: string;
}

/** View model for the generated aggregate client class and DI registration extension class. */
export interface ExtensionsView {
  /** Name of the static extensions class, e.g. `"ApiClientExtensions"`. */
  className: string;
  /** Name of the public extension method, e.g. `"AddApiClient"`. */
  methodName: string;
  /** Name of the aggregate client class, e.g. `"ApiClient"`. */
  clientClassName: string;
  /** C# access modifier of the aggregate client's constructor; `"internal"` when any endpoint is internal. */
  constructorAccess: string;
  /** Ordered list of Refit interface entries. */
  interfaces: InterfaceEntry[];
}
/** View model for the generated `.csproj` project file. */
export interface CsprojView {
  /** C# root namespace. */
  rootNamespace: string;
  /**
   * Target framework moniker(s). Single: `"net8.0"`. Multi-target: `"net8.0;net9.0"`.
   * Use together with {@link isMultiTarget} to choose the correct MSBuild element.
   */
  netVersion: string;
  /** `true` when `netVersion` contains multiple TFMs; drives `<TargetFrameworks>` vs `<TargetFramework>`. */
  isMultiTarget: boolean;
  /** NuGet `<Description>`. Always present; defaults to a generated string when not supplied. */
  nugetDescription: string;
  /** NuGet `<PackageId>`. Omitted from the project file when undefined. */
  nugetPackageId?: string;
  /** NuGet `<Version>`. Always present; derived from the API version or CalVer when not supplied via option. */
  nugetVersion: string;
  /** NuGet `<Authors>`. Omitted when undefined. */
  nugetAuthors?: string;
  /** NuGet `<Title>`. Omitted when undefined. */
  nugetTitle?: string;
  /** NuGet `<PackageTags>`. Omitted when undefined. */
  nugetTags?: string;
}

/** Stateless code renderer. Obtain an instance via {@link createRenderer}. */
export interface Renderer {
  /** Renders the full file: `// <auto-generated />`, usings, file-scoped namespace, body. */
  renderFile(view: FileView): string;
  /** Renders a `public record` declaration with its properties. */
  renderRecord(view: RecordView): string;
  /** Renders a `public enum` declaration with its members. */
  renderEnum(view: EnumView): string;
  /** Renders a Refit `public interface` declaration with its methods. */
  renderRefitInterface(view: RefitInterfaceView): string;
  /** Renders the `.csproj` project file content. */
  renderCsproj(view: CsprojView): string;
  /** Renders the aggregate client and DI registration extension class bodies. */
  renderExtensions(view: ExtensionsView): string;
  /** Renders the `MergePatch<T>` helper class body. Takes no view model. */
  renderMergePatch(): string;
  /** Renders the internal `ClientRuntime` helper class body. Takes no view model. */
  renderClientRuntime(): string;
}
/**
 * Builds the Handlebars environment shared by every template, registering the
 * helpers documented at the top of each `.hbs` file.
 *
 * @returns An isolated Handlebars environment.
 */
function createHandlebarsEnv(): typeof Handlebars {
  const env = Handlebars.create();

  env.registerHelper("indent", (content: unknown) => {
    if (typeof content !== "string" || !content) return "";
    return content
      .split("\n")
      .map((line) => (line.length ? `    ${line}` : ""))
      .join("\n");
  });

  // Splits doc text on newlines and rejoins with `\n{prefix}` so that every
  // continuation line in a /// <summary> block gets the correct leading prefix.
  env.registerHelper("docLines", (doc: unknown, prefix: unknown) => {
    if (typeof doc !== "string" || !doc) return "";
    const sep = typeof prefix === "string" ? `\n${prefix}` : "\n/// ";
    return doc.split("\n").join(sep);
  });

  env.registerHelper("isDefined", (value: unknown) => value !== undefined);

  env.registerHelper("eq", (a: unknown, b: unknown) => a === b);

  env.registerHelper("fx", (name: unknown, use: unknown) =>
    fx(String(name), typeof use === "string" ? (use as FrameworkUse) : "type"),
  );

  env.registerHelper("declaredName", (name: unknown) =>
    typeof name === "string" ? csDeclarationName(name) : name,
  );

  return env;
}

/**
 * Compiles template source with HTML escaping disabled (the output is C#, not HTML).
 *
 * @param env - The Handlebars environment.
 * @param source - The template source text.
 * @returns The compiled template function.
 */
function compileTemplate(
  env: typeof Handlebars,
  source: string,
): HandlebarsTemplateDelegate {
  return env.compile(source, { noEscape: true });
}

/**
 * Loads and compiles a named template, preferring a user-supplied override path.
 *
 * @param env - The Handlebars environment.
 * @param name - The built-in template name.
 * @param override - Absolute path of a replacement template, if configured.
 * @returns The compiled template function.
 */
function loadTemplate(
  env: typeof Handlebars,
  name: TemplateName,
  override: string | undefined,
): HandlebarsTemplateDelegate {
  const path = override ?? resolve(TEMPLATES_DIR, `${name}.hbs`);
  // Line endings are part of the output. A template checked out with CRLF (Git's
  // autocrlf on Windows, or a user's own override) must not leak into the generated
  // C#, which is always written with LF.
  const source = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  // Every framework type the C# names goes through the fx helper, so a generated
  // type of the same name cannot hide it. The project file is XML, not C#.
  return compileTemplate(
    env,
    name === "csproj" ? source : qualifyTemplate(source),
  );
}

/**
 * The generated summary of a method whose operation has no documentation, so every
 * public member still carries XML documentation.
 *
 * @param m - The method view.
 * @returns The summary text (XML-safe: it names only identifiers and a verb).
 */
function methodSummary(m: MethodView): string {
  return `Sends the <c>${m.httpMethod.toUpperCase()}</c> request of the <c>${m.methodName}</c> operation.`;
}

/**
 * Renders one Refit interface method: its XML summary, the verb attribute with the
 * route, any `[Headers]` and runtime attributes, and the signature.
 *
 * @param m - The method view.
 * @returns The rendered member, indented for placement inside an interface.
 */
function renderMethodBlock(m: MethodView): string {
  const lines = ["    /// <summary>"];
  for (const docLine of (m.doc || methodSummary(m)).split("\n")) {
    lines.push(`    /// ${docLine}`);
  }
  lines.push("    /// </summary>");
  lines.push(`    [${fx(m.httpMethod, "attribute")}("${m.route}")]`);
  if (m.headers.length > 0) {
    lines.push(
      `    [${fx("Headers", "attribute")}(${m.headers.map((h) => `"${h}"`).join(", ")})]`,
    );
  }
  for (const attribute of m.attributes) lines.push(`    [${attribute}]`);
  for (const attribute of m.returnAttributes) {
    lines.push(`    [return: ${attribute}]`);
  }
  lines.push(`    ${m.returnType} ${m.methodName}(${m.paramsText});`);
  return lines.join("\n");
}

/**
 * Compiles all templates and returns a {@link Renderer} instance.
 *
 * Templates are compiled once; the returned renderer is cheap to call
 * repeatedly. Any template absent from `overrides` falls back to its bundled
 * `.hbs` file.
 *
 * @param overrides - Optional absolute paths replacing built-in templates.
 * @returns A ready-to-use renderer.
 * @throws If any template file (built-in or custom) cannot be read or parsed.
 */
export function createRenderer(overrides: TemplateOverrides = {}): Renderer {
  const env = createHandlebarsEnv();
  const fileTemplate = loadTemplate(env, "file", overrides.file);
  const recordTemplate = loadTemplate(env, "record", overrides.record);
  const enumTemplate = loadTemplate(env, "enum", overrides.enum);
  const interfaceTemplate = loadTemplate(
    env,
    "refit-interface",
    overrides["refit-interface"],
  );
  const csprojTemplate = loadTemplate(env, "csproj", overrides.csproj);
  const extensionsTemplate = loadTemplate(
    env,
    "extensions",
    overrides.extensions,
  );
  const mergePatchTemplate = loadTemplate(
    env,
    "merge-patch",
    overrides["merge-patch"],
  );
  const clientRuntimeTemplate = loadTemplate(
    env,
    "client-runtime",
    overrides["client-runtime"],
  );

  return {
    renderFile(view) {
      return fileTemplate(view);
    },

    renderRecord(view) {
      return recordTemplate(view);
    },

    renderEnum(view) {
      return enumTemplate(view);
    },

    renderRefitInterface(view) {
      const methodBlocks = view.methods.map(renderMethodBlock);
      const methodsBlock =
        methodBlocks.length > 0 ? methodBlocks.join("\n\n") + "\n" : "";
      return interfaceTemplate({
        interfaceName: view.interfaceName,
        doc: view.doc,
        access: view.access,
        methodsBlock,
      });
    },

    renderCsproj(view) {
      return csprojTemplate(view);
    },

    renderExtensions(view) {
      return extensionsTemplate(view);
    },

    renderMergePatch() {
      return mergePatchTemplate({});
    },

    renderClientRuntime() {
      return clientRuntimeTemplate({});
    },
  };
}

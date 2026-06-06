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
  | "extensions";

/**
 * Partial map of template names to absolute file paths used to override the
 * built-in defaults. Any template not listed falls back to its bundled counterpart.
 */
export type TemplateOverrides = Partial<Record<TemplateName, string>>;

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** View model for a single C# property declaration inside a record. */
export interface PropertyView {
  /** Optional XML doc text (pre-escaped). Rendered as `/// <summary>...</summary>`. */
  doc?: string;
  /** Full C# type including optional `?`, e.g. `"string"`, `"int?"`, `"List<Pet>"`. */
  type: string;
  /** PascalCase property name. */
  name: string;
  /** JSON wire name written to `[JsonPropertyName("...")]`, e.g. `"firstName"`. Always the original TypeSpec property name. */
  jsonPropertyName: string;
  /** Default initializer expression (without `= ` and `;`), e.g. `"default!"`, `"[]"`. */
  defaultValue?: string;
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
}

/** View model for a single C# enum member. */
export interface EnumMemberView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase member name. */
  name: string;
  /** Wire string written to / read from JSON for `[EnumMember(Value = "...")]`. */
  memberValue: string;
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
}

/** View model for a single Refit interface method. */
export interface MethodView {
  /** Optional XML doc text (pre-escaped). */
  doc?: string;
  /** PascalCase HTTP verb, e.g. `"Get"`, `"Post"`. */
  verb: string;
  /** Route path string, e.g. `"/widgets/{id}"`. */
  path: string;
  /** C# return type, e.g. `"Task<Widget>"` or `"Task"`. */
  returnType: string;
  /** Method name, e.g. `"ListAsync"`. */
  methodName: string;
  /** Pre-rendered comma-separated parameter list string. */
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
  /** Constructor parameter name, e.g. `"stores"`. */
  paramName: string;
}

/** View model for the generated aggregate client class and DI registration extension class. */
export interface ExtensionsView {
  /** Name of the static extensions class, e.g. `"ApiClientExtensions"`. */
  className: string;
  /** Name of the public extension method, e.g. `"AddApiClient"`. */
  methodName: string;
  /** Name of the aggregate client class, e.g. `"ApiClient"`. */
  clientClassName: string;
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

// ---------------------------------------------------------------------------
// Renderer interface
// ---------------------------------------------------------------------------

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
  /** Renders the DI registration extension class body. */
  renderExtensions(view: ExtensionsView): string;
}

// ---------------------------------------------------------------------------
// Handlebars environment
// ---------------------------------------------------------------------------

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

  return env;
}

function compileTemplate(
  env: typeof Handlebars,
  source: string,
): HandlebarsTemplateDelegate {
  return env.compile(source, { noEscape: true });
}

function loadTemplate(
  env: typeof Handlebars,
  name: TemplateName,
  override: string | undefined,
): HandlebarsTemplateDelegate {
  const path = override ?? resolve(TEMPLATES_DIR, `${name}.hbs`);
  const source = readFileSync(path, "utf-8");
  return compileTemplate(env, source);
}

// ---------------------------------------------------------------------------
// Per-element text renderers
// ---------------------------------------------------------------------------

function renderMethodBlock(m: MethodView): string {
  const lines: string[] = [];
  if (m.doc) {
    lines.push(`    /// <summary>`);
    for (const docLine of m.doc.split("\n")) {
      lines.push(`    /// ${docLine}`);
    }
    lines.push(`    /// </summary>`);
  }
  lines.push(`    [${m.verb}("${m.path}")]`);
  lines.push(`    ${m.returnType} ${m.methodName}(${m.paramsText});`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compiles all templates and returns a {@link Renderer} instance.
 *
 * Templates are compiled once; the returned renderer is cheap to call
 * repeatedly. Any template absent from `overrides` falls back to its bundled
 * `.hbs` file.
 *
 * @throws If any template file (built-in or custom) cannot be read or parsed.
 */
export function createRenderer(overrides: TemplateOverrides = {}): Renderer {
  const env = createHandlebarsEnv();
  const fileTemplate = loadTemplate(env, "file", overrides.file);
  const recordTemplate = loadTemplate(env, "record", overrides.record);
  const enumTemplate = loadTemplate(env, "enum", overrides.enum);
  const refitInterfaceTemplate = loadTemplate(
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
      return refitInterfaceTemplate({
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
  };
}

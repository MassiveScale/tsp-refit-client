// Shared, dependency-light helpers: C# type mapping (TypeSpec type → C# type
// string) and the small name / formatting utilities used across the emitter.
// This module is a leaf — it depends only on the compiler and decorators, never
// on the other codegen modules — so it can be imported freely without cycles.

import {
  Model,
  ModelProperty,
  Scalar,
  Enum,
  Type,
  Program,
  getEncode,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isNullType,
  isVoidType,
  isNeverType,
  isErrorModel,
} from "@typespec/compiler";
import { getClientName } from "./decorators.js";

/**
 * Maps a TypeSpec type to its C# type expression (e.g. `int32` → `int`,
 * `Widget[]` → `List<Widget>`, `Record<string>` → `Dictionary<string, string>`).
 *
 * As a side effect, any named model or enum encountered is registered into
 * `models` / `enums` so the caller emits a corresponding record/enum file.
 *
 * @param type - The TypeSpec type to map.
 * @param program - The compiler program, used for scalar formats and client names.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @returns The C# type expression as a string (`"object"` for unmappable types).
 */
export function mapType(
  type: Type,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): string {
  switch (type.kind) {
    case "Scalar":
      return mapScalar(type as Scalar, program);

    case "Model": {
      const m = type as Model;
      if (isArrayModelType(m)) {
        return `List<${mapType(m.indexer!.value, program, models, enums)}>`;
      }
      if (isRecordModelType(m)) {
        return `Dictionary<string, ${mapType(m.indexer!.value, program, models, enums)}>`;
      }
      if (isErrorModel(program, m)) {
        // Still emit, just note it
      }
      if (!m.name) return "object";

      // Template instance
      if (m.templateMapper?.args) {
        const args = m.templateMapper.args
          .filter(
            (a): a is Type =>
              (a as { entityKind?: string }).entityKind === "Type",
          )
          .map((a) => mapType(a, program, models, enums));
        // Array<T> represented as a template instance (unresolved element type) → List<T>
        if (m.name === "Array" && args.length === 1) {
          return `List<${args[0]}>`;
        }
        const decl = m.namespace?.models.get(m.name);
        if (decl) models.set(m.name, decl);
        else models.set(m.name, m);
        const csName = getClientName(program, decl ?? m) ?? m.name;
        return args.length > 0 ? `${csName}<${args.join(", ")}>` : csName;
      }

      models.set(m.name, m);
      return getClientName(program, m) ?? m.name;
    }

    case "Enum": {
      const e = type as Enum;
      if (e.name) enums.set(e.name, e);
      return e.name ? (getClientName(program, e) ?? e.name) : "string";
    }

    case "Union":
      return "string";

    case "Intrinsic":
      if (isVoidType(type)) return "void";
      if (isNullType(type)) return "object";
      if (isNeverType(type)) return "object";
      return "object";

    case "TemplateParameter":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (type as any).node?.id?.sv ?? "T";

    default:
      return "object";
  }
}

/**
 * Maps a model property to its C# type, taking `@encode` into account before
 * delegating to {@link mapType}. A `boolean` property carrying `@encode("string")`
 * travels on the wire as a JSON string (`"true"`/`"false"`), so it is emitted as
 * C# `string` rather than `bool`; all other properties map by their declared type.
 *
 * @param prop - The model property to map (source of both the type and `@encode`).
 * @param program - The compiler program, used to read `@encode` and scalar formats.
 * @param models - Accumulator that collects referenced named models by name.
 * @param enums - Accumulator that collects referenced named enums by name.
 * @returns The C# type expression as a string.
 */
export function mapPropertyType(
  prop: ModelProperty,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): string {
  const encode = getEncode(program, prop);
  const encodesAsString =
    encode !== undefined &&
    (encode.encoding === "string" ||
      (encode.type !== undefined &&
        builtinScalarName(encode.type) === "string"));
  if (
    encodesAsString &&
    prop.type.kind === "Scalar" &&
    builtinScalarName(prop.type as Scalar) === "boolean"
  ) {
    return "string";
  }
  return mapType(prop.type, program, models, enums);
}

/**
 * Maps a TypeSpec scalar to its C# type, honouring `@format` (`uuid` → `Guid`,
 * `uri`/`url` → `Uri`) and walking the scalar's base chain to resolve custom
 * scalars down to a known built-in.
 *
 * @param scalar - The scalar type to map.
 * @param program - The compiler program, used to read the scalar's `@format`.
 * @returns The C# type name (defaults to `"string"` for unrecognized scalars).
 */
function mapScalar(scalar: Scalar, program: Program): string {
  const fmt = getFormat(program, scalar);
  if (fmt === "uuid") return "Guid";
  if (fmt === "uri" || fmt === "url") return "Uri";

  const builtin = builtinScalarName(scalar);
  switch (builtin) {
    case "string":
      return "string";
    case "int8":
      return "sbyte";
    case "int16":
      return "short";
    case "int32":
      return "int";
    case "int64":
      return "long";
    case "uint8":
      return "byte";
    case "uint16":
      return "ushort";
    case "uint32":
      return "uint";
    case "uint64":
      return "ulong";
    case "safeint":
      return "long";
    case "float32":
      return "float";
    case "float64":
      return "double";
    case "decimal":
    case "decimal128":
      return "decimal";
    case "boolean":
      return "bool";
    case "bytes":
      return "byte[]";
    case "utcDateTime":
    case "offsetDateTime":
      return "DateTimeOffset";
    case "plainDate":
      return "DateOnly";
    case "plainTime":
      return "TimeOnly";
    case "duration":
      return "TimeSpan";
    case "url":
      return "Uri";
    case "numeric":
    case "integer":
    case "float":
      return "double";
    default:
      return "string";
  }
}

/** Names of the TypeSpec built-in scalars that `mapScalar` knows how to map. */
const BUILTIN_SCALARS = new Set([
  "string",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
  "integer",
  "float",
  "float32",
  "float64",
  "decimal",
  "decimal128",
  "numeric",
  "boolean",
  "bytes",
  "utcDateTime",
  "offsetDateTime",
  "plainDate",
  "plainTime",
  "duration",
  "url",
]);

/**
 * Walks a scalar's `baseScalar` chain and returns the name of the first
 * ancestor (inclusive) that is a known built-in, so custom scalars resolve to
 * the built-in they ultimately derive from.
 *
 * @param scalar - The scalar to resolve.
 * @returns The built-in scalar name, or the scalar's own name if none is found.
 */
function builtinScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (BUILTIN_SCALARS.has(current.name)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

/**
 * Turns an API version value into a C# namespace segment, e.g. `v2.0` → `V2_0`
 * (strips a leading `v`/`V`, prefixes `V`, and replaces dots with underscores).
 *
 * @param version - The raw TypeSpec version value.
 * @returns A namespace-safe version segment.
 */
export function sanitizeVersionForNs(version: string): string {
  return "V" + version.replace(/^v/i, "").replace(/\./g, "_");
}

/**
 * Upper-cases the first character of a string, leaving the rest unchanged.
 *
 * @param s - The string to capitalize.
 * @returns The capitalized string (empty input returns empty).
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Derives the C# method name for an operation: PascalCase plus the `Async`
 * suffix (e.g. `list` → `ListAsync`).
 *
 * @param name - The TypeSpec operation name.
 * @returns The C# method name.
 */
export function toCsMethodName(name: string): string {
  return capitalize(name) + "Async";
}

/**
 * Derives the C# parameter name (camelCase) by lower-casing the first character.
 *
 * @param name - The source name.
 * @returns The camelCase parameter name.
 */
export function toCsParamName(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Derives the C# property name (PascalCase) by upper-casing the first character.
 *
 * @param name - The source name.
 * @returns The PascalCase property name.
 */
export function toCsPropName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Escapes the XML metacharacters `&`, `<`, and `>` (in that order, so `&` is not
 * double-escaped) for safe inclusion in XML doc comments.
 *
 * @param s - The raw text.
 * @returns The XML-escaped text.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sorts C# `using` namespaces with all `System*` namespaces first, then the rest,
 * each group ordered alphabetically. Does not mutate the input array.
 *
 * @param usings - The namespaces to sort.
 * @returns A new, sorted array.
 */
export function sortUsings(usings: string[]): string[] {
  return [...usings].sort((a, b) => {
    const aSystem = a.startsWith("System");
    const bSystem = b.startsWith("System");
    if (aSystem && !bSystem) return -1;
    if (!aSystem && bSystem) return 1;
    return a.localeCompare(b);
  });
}

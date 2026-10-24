// Endpoint (Refit interface) generation: turns each TypeSpec operation container
// into a C# `interface` of Refit-attributed methods, resolves route paths and
// parameter bindings, decides how each body and response travels, and collects
// the visibility-filtered request payload types referenced by write operations
// (rendered as records by ./models.ts).

import { fx } from "./framework.js";
import {
  getEncode,
  Model,
  ModelProperty,
  Enum,
  Type,
  Program,
  isArrayModelType,
  Operation,
  getPagingOperation,
  isList,
  type PagingProperty,
} from "@typespec/compiler";
import {
  HttpOperation,
  HttpOperationResponse,
  HttpPayloadBody,
  Visibility,
  isVisible,
  resolveRequestVisibility,
} from "@typespec/http";
import { getMergePatchSource } from "@typespec/http/experimental/merge-patch";
import type { Version } from "@typespec/versioning";
import {
  Renderer,
  RefitInterfaceView,
  MethodView,
  PayloadKind,
  FileView,
  PagingMethodView,
  PagingStrategy,
} from "./renderer.js";
import { getClientName, getAccess } from "./decorators.js";
import { checkName, MemberScope } from "./names.js";
import {
  checkEncoding,
  classifyEncoding,
  isDelimited,
  reportUnsupportedEncoding,
  type WireEncoding,
} from "./encoding.js";
import { createDiagnostic, reportOnce } from "./lib.js";
import {
  docText,
  mapType,
  mapPropertyType,
  builtinScalarName,
  capitalize,
  toCsMethodName,
  toCsPagingMethodName,
  toCsParamName,
  escapeCsIdentifier,
  unwrapType,
  type TypeWrapper,
  escapeCsString,
  sortUsings,
  isInVersion,
  soleVariant,
  MERGE_PATCH_HELPER_NAME,
  MERGE_PATCH_INTERFACE_NAME,
  type UsedHelpers,
  toCsPropName,
} from "./utils.js";
import {
  findDiscriminatedRoot,
  findNestedDiscriminator,
  flattenProperties,
  reachableModels,
  reportValueTemplate,
  valueTemplateParameter,
  hierarchyOf,
} from "./models.js";

/**
 * A visibility-filtered request payload synthesized for a write operation whose
 * body has properties hidden in the request context, at any depth. Collected while
 * building methods and rendered as a record by `buildFilteredRecord`, or by
 * `buildRecord` for a model of a `@discriminator` hierarchy.
 */
export interface RequestType {
  /** C# record name for the synthesized request type (e.g. `WidgetCreateRequest`). */
  name: string;
  /** The model this record mirrors. */
  model: Model;
  /** Doc comment carried over from the source model, if any. */
  doc: string | undefined;
  /** The properties visible in the request context, keyed by property name. */
  props: Map<string, ModelProperty>;
  /**
   * C# access modifier of the record: that of the source model, so a record built
   * from an internal model can still reference other internal types.
   */
  access: string;
  /** The operation's request visibility. */
  visibility: Visibility;
  /**
   * The models this record's properties hold that have request records of their
   * own, which the properties are written as instead: `Wrapper { child: Child }`
   * becomes `WrapperCreateRequest { ChildCreateRequest Child }`.
   */
  writes: ReadonlySet<Model>;
  /** What every request record of the operation appends to its model's name, e.g. `CreateRequest`. */
  suffix: string;
  /**
   * Whether the model is part of a `@discriminator` hierarchy. Its record is then
   * one of a set mirroring that hierarchy (`PetCreateRequest`, `DogCreateRequest`,
   * ...), rendered from the model so it keeps its base record and
   * `[JsonDerivedType]` list, and so still writes the discriminator.
   */
  discriminated: boolean;
}

/**
 * The C# name a model's request record has under a suffix, e.g. `Widget` and
 * `CreateRequest` give `WidgetCreateRequest`. It follows the model's effective
 * (client) name, so renaming `Widget` to `Product` gives `ProductCreateRequest`.
 *
 * @param program - The compiler program.
 * @param model - The model.
 * @param suffix - The operation's request record suffix.
 * @returns The request record's name.
 */
export function requestRecordName(
  program: Program,
  model: Model,
  suffix: string,
): string {
  return `${getClientName(program, model) ?? model.name}${suffix}`;
}

/**
 * The C# type a request record writes in place of a model: the model's request
 * record when it is one the record writes (see {@link RequestType.writes}),
 * otherwise nothing, so the model maps as usual. Passed to the type mapping as its
 * `substitute`.
 *
 * @param program - The compiler program.
 * @param requestType - The request record.
 * @returns The substitution.
 */
export function requestSubstitute(
  program: Program,
  requestType: RequestType,
): (model: Model) => string | undefined {
  return (model) =>
    requestType.writes.has(model)
      ? requestRecordName(program, model, requestType.suffix)
      : undefined;
}

/**
 * One already-rendered method parameter, tracked alongside its source
 * `ModelProperty` (when it has one) so paging codegen can later identify which
 * parameter corresponds to a paging input role (`continuationToken`/`offset`/
 * `pageIndex`) without re-deriving names from scratch. Body parameters and the
 * synthetic `additionalQueryParameters` bag have no source property.
 */
interface ParamInfo {
  /** C# parameter name, e.g. `"skip"`. */
  name: string;
  /** Full parameter declaration text for the raw Refit method, e.g. `"[AliasAs(\"$skip\")] int? skip = null"`. */
  declaration: string;
  /** Same declaration with any Refit binding attribute (`[Query]`/`[Header]`/`[Body]`/`[AliasAs]`) stripped, e.g. `"int? skip = null"` — for the paging wrapper, a plain static method Refit never sees. */
  plainDeclaration: string;
  /** The TypeSpec property this parameter was derived from, if any. */
  property?: ModelProperty;
  /**
   * For a header or cookie parameter, the request option the raw method sets for it, which the
   * runtime's message handler writes in wire format. A `nextLink` continuation request bypasses
   * Refit, so it sets the same option itself.
   */
  replay?: {
    /** The `ClientRuntime` key prefix: `HeaderPrefix` or `CookiePrefix`. */
    prefix: "HeaderPrefix" | "CookiePrefix";
    /** The wire name, e.g. `X-Tenant-Id`. */
    name: string;
    /** The parameter's wire format, applied before the handler writes it. */
    wire?: WireEncoding;
  };
}

/**
 * Maps an HTTP verb to the request-type name suffix: `post` → `Create`,
 * `patch` → `Update`, `put` → `Replace`; any other verb is Capitalized as-is.
 *
 * @param verb - The lowercase HTTP verb.
 * @returns The suffix inserted before `Request` in the synthesized type name.
 */
function requestTypeSuffix(verb: string): string {
  switch (verb) {
    case "post":
      return "Create";
    case "patch":
      return "Update";
    case "put":
      return "Replace";
    default:
      return capitalize(verb);
  }
}

/**
 * Selects the properties of a body model that are visible in a given request
 * context, honouring both `@visibility` and per-version availability.
 *
 * @param model - The request body model.
 * @param visibility - The resolved request visibility for the operation.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param program - The compiler program.
 * @returns The visible `[name, property]` pairs, keyed by property name.
 */
function filterPropsForRequest(
  model: Model,
  visibility: Visibility,
  version: Version | undefined,
  program: Program,
): Map<string, ModelProperty> {
  const result = new Map<string, ModelProperty>();
  for (const [name, prop] of flattenProperties(model)) {
    if (!isInVersion(program, prop, version)) continue;
    if (!isVisible(program, prop, visibility)) continue;
    result.set(name, prop);
  }
  return result;
}

/**
 * Puts a C# element type back inside what a body declared around it: a list, a
 * dictionary, or `| null` as `?`.
 *
 * @param csType - The element's C# type.
 * @param wrappers - What wraps it, from the outside in.
 * @returns The C# body parameter type.
 */
function wrapBody(csType: string, wrappers: TypeWrapper[]): string {
  return wrappers.reduceRight(
    (inner, wrapper) =>
      wrapper === "array"
        ? `${fx("List", "generic")}<${inner}>`
        : wrapper === "record"
          ? `${fx("Dictionary", "generic")}<string, ${inner}>`
          : inner.endsWith("?")
            ? inner
            : `${inner}?`,
    csType,
  );
}
/**
 * The named models a property type writes as JSON objects of their own, looking
 * through arrays, records and `| null`. A union of several types is held as a
 * `JsonElement`, an anonymous model as `object`, and a merge-patch payload is
 * already purpose-built, so none of them leads anywhere.
 *
 * @param program - The compiler program.
 * @param type - The property type.
 * @returns The models it reaches.
 */
function modelsWrittenBy(program: Program, type: Type): Model[] {
  const { element } = unwrapType(type);
  if (
    element.kind !== "Model" ||
    !element.name ||
    isSynthesizedMergePatchModel(program, element)
  ) {
    return [];
  }
  return [element];
}

/**
 * The models of a request body that need a request record of their own. A model
 * needs one when it has a property hidden in the request, when one of its visible
 * properties holds a model that needs one (so `Wrapper { child: Child }` needs one
 * when `Child` has a read-only `id`), or when another model of its
 * `@discriminator` hierarchy needs one, since the records of a hierarchy inherit
 * from one another.
 *
 * @param program - The compiler program.
 * @param body - The body model.
 * @param visibility - The operation's request visibility.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @returns The models that need a request record, the body first when it does;
 *   empty when the body can be sent as it is.
 */
function findRequestModels(
  program: Program,
  body: Model,
  visibility: Visibility,
  version: Version | undefined,
): Model[] {
  const reached: Model[] = [];
  const writes = new Map<Model, Model[]>();
  const hierarchies = new Map<Model, Model[]>();
  const queue = [body];
  while (queue.length > 0) {
    const model = queue.shift()!;
    if (reached.includes(model)) continue;
    reached.push(model);
    const discriminated = findDiscriminatedRoot(program, model);
    if (discriminated) {
      const members = hierarchyOf(program, discriminated.root, version);
      hierarchies.set(model, members);
      queue.push(...members);
    }
    const written = [
      ...filterPropsForRequest(model, visibility, version, program).values(),
    ].flatMap((prop) => modelsWrittenBy(program, prop.type));
    writes.set(model, written);
    queue.push(...written);
  }

  const needs = new Set(
    reached.filter((model) =>
      hasHiddenProperties(model, visibility, version, program),
    ),
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const model of reached) {
      if (needs.has(model)) continue;
      const needed =
        writes.get(model)!.some((m) => needs.has(m)) ||
        (hierarchies.get(model) ?? []).some((m) => needs.has(m));
      if (needed) {
        needs.add(model);
        changed = true;
      }
    }
  }
  return reached.filter((model) => needs.has(model));
}

/**
 * Whether two request records carry exactly the same properties, and write the
 * same models as request records, so one record can serve both operations.
 *
 * @param a - One record.
 * @param b - The other record.
 * @returns `true` when both list the same properties in the same order.
 */
function sameRequestShape(a: RequestType, b: RequestType): boolean {
  const left = [...a.props];
  const right = [...b.props];
  return (
    left.length === right.length &&
    left.every(
      ([name, prop], i) => right[i][0] === name && right[i][1] === prop,
    ) &&
    a.writes.size === b.writes.size &&
    [...a.writes].every((m) => b.writes.has(m))
  );
}

/**
 * Names and registers the request records for an operation's body: one for every
 * model that needs one (see `findRequestModels`), which can be the body alone, the
 * models of its `@discriminator` hierarchy, or models nested in it. All of them
 * share one suffix, so `Pet`, `Dog` and `Cat` become `PetCreateRequest`,
 * `DogCreateRequest` and `CatCreateRequest`.
 *
 * Visibility is resolved per operation (`@parameterVisibility` can differ between
 * two creates of the same model), so a record is shared only when its shape
 * matches. The suffixes tried, in order, are `{Verb}Request` (`CreateRequest`),
 * `{Operation}Request` (`CreateDraftRequest`), and `{Container}{Operation}Request`.
 * A suffix is used only when every record it names is free or already identical,
 * and no two of the operation's models would share a name. When none is, a
 * `name-collision` is reported.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param op - The operation the records are for.
 * @param operationName - The operation's effective (client) name.
 * @param records - The records to register, not yet named.
 * @param requestTypes - The records registered so far for this unit.
 * @returns The suffix used, or `undefined` after reporting a collision.
 */
function claimRequestTypes(
  program: Program,
  op: HttpOperation,
  operationName: string,
  records: Omit<RequestType, "name" | "suffix">[],
  requestTypes: Map<string, RequestType>,
): string | undefined {
  const container = op.container;
  const containerName =
    container.kind === "Interface"
      ? (getClientName(program, container) ?? container.name)
      : container.name;
  const operation = capitalize(operationName);
  const suffixes = [
    ...new Set([
      `${requestTypeSuffix(op.verb)}Request`,
      `${operation}Request`,
      `${capitalize(containerName)}${operation}Request`,
    ]),
  ];

  for (const suffix of suffixes) {
    const named = records.map((record) => ({
      ...record,
      name: requestRecordName(program, record.model, suffix),
      suffix,
    }));
    const usable =
      new Set(named.map((r) => r.name)).size === named.length &&
      named.every((record) => {
        const existing = requestTypes.get(record.name);
        return !existing || sameRequestShape(existing, record);
      });
    if (!usable) continue;
    for (const record of named) {
      if (!requestTypes.has(record.name)) {
        requestTypes.set(record.name, record);
      }
    }
    return suffix;
  }

  reportOnce(
    program,
    createDiagnostic({
      code: "name-collision",
      target: op.operation,
      format: {
        kind: "request record",
        name: requestRecordName(
          program,
          records[0].model,
          suffixes[suffixes.length - 1],
        ),
        scope: "the generated models",
        first:
          "another operation whose request has different visible properties",
        second: `operation "${operationName}"`,
      },
    }),
  );
  return undefined;
}

/**
 * Whether a model is a merge-patch payload synthesized by `@typespec/http`
 * (`MergePatchUpdate<Widget>`), which is already purpose-built for the request and
 * is passed through without visibility filtering. It is recognized by the
 * compiler's merge-patch metadata, not by its name, so a user model called
 * `AuditMergePatchUpdate` is filtered like any other.
 *
 * @param program - The compiler program.
 * @param model - The candidate body model.
 * @returns `true` for a synthesized merge-patch model.
 */
function isSynthesizedMergePatchModel(program: Program, model: Model): boolean {
  return getMergePatchSource(program, model) !== undefined;
}

/**
 * Whether a model has at least one property hidden in the given request context,
 * among those of the version being emitted.
 *
 * @param model - The model.
 * @param visibility - The resolved request visibility for the operation.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param program - The compiler program.
 * @returns `true` if any (flattened) property is not visible.
 */
function hasHiddenProperties(
  model: Model,
  visibility: Visibility,
  version: Version | undefined,
  program: Program,
): boolean {
  for (const [, prop] of flattenProperties(model)) {
    if (!isInVersion(program, prop, version)) continue;
    if (!isVisible(program, prop, visibility)) return true;
  }
  return false;
}

/**
 * Resolves the configured route prefix for a version: substitutes the
 * `{version}` token with the version value (or removes it when unversioned),
 * collapses duplicate/trailing slashes, and percent-encodes any brace left over.
 * Refit would read a brace as a placeholder that no parameter fills, and throw
 * when the client is created; a URI path needs it encoded anyway.
 *
 * @param prefix - The raw `route-prefix` option value.
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @returns The normalized route prefix (no leading/trailing slash artifacts).
 */
function resolveRoutePrefix(
  prefix: string,
  version: Version | undefined,
): string {
  let resolved = prefix;
  if (version) {
    resolved = resolved.replace(/\{version\}/g, version.value);
  } else {
    resolved = resolved.replace(/\{version\}/g, "");
  }
  return resolved
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .replace(/\{/g, "%7B")
    .replace(/\}/g, "%7D");
}

/**
 * Turns a route template such as `/widgets/{id}/analyze` into the route of a Refit
 * verb attribute, escaped for a C# string literal. Refit binds plain `{name}`
 * placeholders and percent-encodes every value, so RFC 6570 operators and the
 * explode marker are dropped (`{+id}` is `{id}`). A path parameter that allows
 * reserved characters keeps its `/` unencoded through Refit's round-trip
 * placeholder (`{**path}`).
 *
 * @param path - The route template, with `{name}` placeholders.
 * @param roundTrip - The wire names of the path parameters written with `{**name}`.
 * @returns The route, starting with `/`, ready to place between quotes.
 */
export function buildRoute(
  path: string,
  roundTrip: ReadonlySet<string> = new Set(),
): string {
  const route = path.replace(/\{[+#./;?&]?([^}*]+)\*?\}/g, (_, name: string) =>
    roundTrip.has(name) ? `{**${name}}` : `{${name}}`,
  );
  return escapeCsString(route.startsWith("/") ? route : `/${route}`);
}

/**
 * Renders the C# Refit `interface` file for one operation container, turning each
 * operation into an attributed method.
 *
 * @param csName - Interface name (e.g. `IPets`).
 * @param csNs - C# namespace the interface is emitted into.
 * @param ops - The HTTP operations to render as methods.
 * @param doc - Optional doc comment for the interface.
 * @param access - C# access modifier of the interface (`public` / `internal`).
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator that collects synthesized request payload
 *   types discovered while building methods.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param rawRoutePrefix - The unresolved `route-prefix` option value.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, appended to every emitted file regardless of whether this particular
 *   file references anything from them (see `EmitterOptions["additional-usings"]`).
 * @param reservePagingClass - Claims the name of the `{Interface}PagingExtensions` class,
 *   a type in the same namespace as the models; returns `false` after reporting a
 *   collision, and the paging wrappers are then left out.
 * @returns The full C# source of the generated interface file, plus, when one of its
 *   operations produced a `nextLink`-strategy paging wrapper, the namespace-qualified
 *   name of the `HttpClient` it resolves, so the caller registers a client under that
 *   name.
 */
export function buildInterface(
  csName: string,
  csNs: string,
  ops: HttpOperation[],
  doc: string | undefined,
  access: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  renderer: Renderer,
  rawRoutePrefix: string,
  additionalUsings: Set<string>,
  reservePagingClass: (className: string) => boolean = () => true,
): { content: string; pagingHttpClientName?: string } {
  const routePrefix = resolveRoutePrefix(rawRoutePrefix, version);
  // `read` and `Read` both become `ReadAsync`, which C# would reject as a duplicate
  // member (or an ambiguous overload), so the second is reported and left out.
  const methodScope = new MemberScope(program, "method", `interface ${csName}`);
  const operationOf = new Map<MethodView, Operation>();
  const methods = ops.flatMap((op) => {
    // An operation whose name is not a valid C# identifier is reported and left
    // out, rather than rendered as a method that cannot compile.
    const declaredName =
      getClientName(program, op.operation) ?? op.operation.name;
    if (!checkName(program, "operation", declaredName, op.operation)) return [];
    const view = buildMethodView(
      op,
      program,
      models,
      enums,
      usedHelpers,
      version,
      requestTypes,
      routePrefix,
      csName,
      csNs,
    );
    if (!view) return [];
    if (
      !methodScope.claim(
        view.methodName,
        `operation "${op.operation.name}"`,
        op.operation,
      )
    ) {
      return [];
    }
    operationOf.set(view, op.operation);
    return [view];
  });

  const view: RefitInterfaceView = {
    interfaceName: csName,
    doc,
    access,
    methods,
  };
  let body = renderer.renderRefitInterface(view);

  // A wrapper is an extension method, so one named like a method of the interface
  // (`listAll` next to a paged `list`) would never be called. The operation keeps its
  // method and the wrapper is left out.
  const rawNames = new Set(methods.map((m) => m.methodName));
  const wrappers = methods.flatMap((m) => {
    if (!m.paging) return [];
    if (rawNames.has(m.paging.methodName)) {
      reportUnsupportedPaging(
        program,
        operationOf.get(m)!,
        `a wrapper name, ${m.paging.methodName}, that another operation's method already uses`,
      );
      return [];
    }
    return [m.paging];
  });
  const pagingClassName = `${csName}PagingExtensions`;
  const pagingMethods =
    wrappers.length > 0 && reservePagingClass(pagingClassName) ? wrappers : [];
  const nextLinkPagingMethod = pagingMethods.find(
    (p) => p.strategy === "nextLink",
  );
  if (pagingMethods.length > 0) {
    body +=
      "\n" +
      renderer.renderPagingExtensions({
        interfaceName: csName,
        className: pagingClassName,
        access,
        methods: pagingMethods,
      });
  }

  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "Refit",
        "System",
        "System.Collections.Generic",
        "System.Text.Json",
        "System.Threading",
        "System.Threading.Tasks",
        ...(pagingMethods.length > 0
          ? ["System.Runtime.CompilerServices"]
          : []),
        ...(nextLinkPagingMethod ? ["System.Net.Http"] : []),
        ...additionalUsings,
      ]),
    ]),
    body,
    fileName: `${csName}.g.cs`,
  };
  return {
    content: renderer.renderFile(fileView),
    pagingHttpClientName: nextLinkPagingMethod?.httpClientName,
  };
}

/**
 * The Refit collection format of a query array: repeated (`tags=a&tags=b`) with
 * `explode`, otherwise one value joined by the `ArrayEncoding` delimiter, or by
 * commas, which is TypeSpec's default (`tags=a,b`).
 *
 * @param explode - Whether the parameter is exploded.
 * @param wire - The parameter's delimited `@encode`, if any.
 * @returns The `CollectionFormat` member name.
 */
function collectionFormat(
  explode: boolean,
  wire: WireEncoding | undefined,
): string {
  if (explode) return "Multi";
  switch (wire) {
    case "PipeDelimited":
      return "Pipes";
    case "SpaceDelimited":
      return "Ssv";
    default:
      return "Csv";
  }
}

/**
 * The `[ClientRuntime.EmptyStatus(...)]` arguments for an operation's bodyless
 * success responses (`Widget | void` declares a 204), so the method returns `null`
 * for them instead of reading the content. A status that also carries a body is
 * left out.
 *
 * @param responses - All of the operation's responses.
 * @param emptyResponses - The success responses that carry no body.
 * @returns One argument list per status code or range, e.g. `204` or `200, 299`.
 */
function emptyStatusArguments(
  responses: HttpOperationResponse[],
  emptyResponses: HttpOperationResponse[],
): string[] {
  const withBody = new Set(
    responses
      .filter((r) => r.responses.some((c) => c.body))
      .map((r) => r.statusCodes),
  );
  return emptyResponses
    .filter((r) => !withBody.has(r.statusCodes))
    .map((r) =>
      typeof r.statusCodes === "number"
        ? `${r.statusCodes}`
        : `${(r.statusCodes as { start: number }).start}, ${(r.statusCodes as { end: number }).end}`,
    );
}

/**
 * The `[ClientRuntime.Encoded(...)]` attribute for a wire format, read by the URL
 * formatter, the content serializer, and the message handler.
 *
 * @param wire - The wire format.
 * @returns The attribute, without brackets.
 */
function encodedAttribute(wire: WireEncoding): string {
  return `ClientRuntime.Encoded(ClientRuntime.WireEncoding.${wire})`;
}

/**
 * Whether a parameter type is a date-time, which TypeSpec sends in a header as an
 * RFC 7231 date unless it is given another `@encode`.
 *
 * @param type - The parameter type.
 * @returns `true` for `utcDateTime` or `offsetDateTime`, or one of them `| null`.
 */
function isDateTime(type: Type): boolean {
  const inner = soleVariant(type)?.type ?? type;
  if (inner.kind !== "Scalar") return false;
  const name = builtinScalarName(inner);
  return name === "utcDateTime" || name === "offsetDateTime";
}

/**
 * Builds the renderer view for a single Refit method: the verb attribute and
 * route, the `[Headers]` that declare the body's media type, the runtime
 * attributes for bodyless statuses and encoded responses, and the ordered
 * parameter list (required first, then optional, then an
 * `additionalQueryParameters` bag and a trailing `CancellationToken`). A write body
 * whose model has hidden properties is swapped for a synthesized request type,
 * which is registered into `requestTypes`.
 *
 * @param op - The HTTP operation to render.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator for synthesized request payload types.
 * @param routePrefix - The already-resolved route prefix for this version.
 * @param csName - Enclosing interface's C# name (e.g. `IStores`), needed only to
 *   stamp a `nextLink`-strategy paging wrapper's `CreateClient(...)` call.
 * @param csNs - Enclosing interface's C# namespace, combined with `csName` into
 *   the named `HttpClient` a `nextLink`-strategy paging wrapper resolves, so
 *   two different services or API versions that both happen to declare an
 *   `IStores` interface don't collide on the same registered client name.
 * @returns The {@link MethodView} for the operation, or `undefined` when the
 *   operation uses something this emitter cannot send or read correctly (it is
 *   reported, and left out, rather than generated with the wrong behaviour).
 */
function buildMethodView(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  routePrefix: string,
  csName: string,
  csNs: string,
): MethodView | undefined {
  const reportUnsupported = (feature: string): undefined => {
    reportOnce(
      program,
      createDiagnostic({
        code: "unsupported-feature",
        target: op.operation,
        format: {
          feature,
          operation: op.operation.name,
          hint: "Call it through a Refit interface or HttpClient of your own instead.",
        },
      }),
    );
    return undefined;
  };
  const unsupported = findUnsupportedPayload(op, program);
  if (unsupported) return reportUnsupported(unsupported);
  const rawPath = routePrefix
    ? `${routePrefix}/${op.path}`.replace(/\/+/g, "/").replace(/\/$/, "")
    : op.path;
  const baseMethodName =
    getClientName(program, op.operation) ?? op.operation.name;
  const methodName = toCsMethodName(baseMethodName);
  const doc = docText(program, op.operation);
  const response = resolveResponse(
    op.responses,
    program,
    models,
    enums,
    usedHelpers,
  );
  registerErrorModels(op.responses, program, models, enums, usedHelpers);

  const requiredParams: ParamInfo[] = [];
  const optionalParams: ParamInfo[] = [];
  const headers: string[] = [];
  const roundTrip = new Set<string>();

  // Parameter names must be unique, and must not collide with the parameters every
  // method adds.
  const paramScope = new MemberScope(
    program,
    "parameter",
    `operation ${baseMethodName}`,
    [
      [
        "additionalQueryParameters",
        "the extra query parameters every method accepts",
      ],
      ["cancellationToken", "the cancellation token every method accepts"],
      ...(op.parameters.body
        ? [["body", "the request body parameter"] as [string, string]]
        : []),
    ],
  );

  for (const param of op.parameters.parameters) {
    // The body's media type decides Content-Type; a caller-supplied value would
    // only be a second source of truth for it.
    if (
      param.type === "header" &&
      param.name.toLowerCase() === "content-type"
    ) {
      continue;
    }
    // A parameter added in a later version is not part of this version's API.
    if (!isInVersion(program, param.param, version)) continue;
    const csType = mapPropertyType(
      param.param,
      program,
      models,
      enums,
      usedHelpers,
    );
    const paramName = getClientName(program, param.param) ?? param.param.name;
    // A parameter whose name is not a valid C# identifier is reported and left out.
    if (!checkName(program, "parameter", paramName, param.param)) continue;
    const unescaped = toCsParamName(paramName);
    if (
      !paramScope.claim(
        unescaped,
        `parameter "${param.param.name}"`,
        param.param,
      )
    ) {
      continue;
    }
    const encoding = checkEncoding(program, param.param, "parameter");
    // A value that cannot travel in the format the API expects is not sent at all.
    if (encoding.support === "unsupported") return undefined;
    // A header (and a cookie, which travels in one) cannot contain a line break, so
    // a newline-delimited list of more than one item can never be sent there.
    if (
      encoding.wire === "NewlineDelimited" &&
      (param.type === "header" || param.type === "cookie")
    ) {
      reportUnsupportedEncoding(
        program,
        param.param,
        "parameter",
        encoding.encoding ?? "",
      );
      return undefined;
    }
    const csParam = escapeCsIdentifier(unescaped);
    const isOptional = param.param.optional;
    const nullableSuffix = isOptional && !csType.endsWith("?") ? "?" : "";
    const attributes: string[] = [];
    // A TypeSpec date-time travels in a header as an RFC 7231 date by default.
    const wire =
      encoding.wire ??
      (param.type === "header" &&
      encoding.support === "default" &&
      encoding.encoding === undefined &&
      isDateTime(param.param.type)
        ? "Rfc7231"
        : undefined);

    let replay: ParamInfo["replay"];

    if (param.type === "query") {
      const isArray =
        param.param.type.kind === "Model" &&
        isArrayModelType(param.param.type as Model);
      // Refit sends each byte of a byte array as its own number, and joins a list
      // itself, so bytes and a newline-delimited list are written by the runtime's
      // message handler instead.
      if (
        csType.replace(/\?$/, "") === "byte[]" ||
        wire === "NewlineDelimited"
      ) {
        attributes.push(
          `${fx("Property", "attribute")}(ClientRuntime.QueryPrefix + "${escapeCsString(param.name)}")`,
        );
        if (wire) attributes.push(encodedAttribute(wire));
        const plainDeclaration = `${csType}${nullableSuffix} ${csParam}${isOptional ? " = null" : ""}`;
        const decl = `${attributes.map((a) => `[${a}] `).join("")}${plainDeclaration}`;
        const info: ParamInfo = {
          name: csParam,
          declaration: decl,
          plainDeclaration,
          property: param.param,
        };
        (isOptional ? optionalParams : requiredParams).push(info);
        continue;
      }
      if (param.name !== unescaped) {
        attributes.push(
          `${fx("AliasAs", "attribute")}("${escapeCsString(param.name)}")`,
        );
      }
      if (isArray) {
        attributes.push(
          `${fx("Query", "attribute")}(${fx("CollectionFormat")}.${collectionFormat(param.explode === true, wire)})`,
        );
      }
      if (wire && !isDelimited(wire)) attributes.push(encodedAttribute(wire));
    } else if (param.type === "path") {
      // Refit writes a round-trip placeholder's value with its `/` intact, which is
      // what `allowReserved` asks for; it only accepts one for a string.
      if (param.allowReserved && csType.replace(/\?$/, "") === "string") {
        roundTrip.add(param.name);
      }
      if (param.name !== unescaped) {
        attributes.push(
          `${fx("AliasAs", "attribute")}("${escapeCsString(param.name)}")`,
        );
      }
      if (wire) attributes.push(encodedAttribute(wire));
    } else if (param.type === "header" || param.type === "cookie") {
      const prefix = param.type === "header" ? "HeaderPrefix" : "CookiePrefix";
      attributes.push(
        `${fx("Property", "attribute")}(ClientRuntime.${prefix} + "${escapeCsString(param.name)}")`,
      );
      if (wire) attributes.push(encodedAttribute(wire));
      replay = { prefix, name: param.name, wire };
    }

    const plainDeclaration = `${csType}${nullableSuffix} ${csParam}${isOptional ? " = null" : ""}`;
    const decl = `${attributes.map((a) => `[${a}] `).join("")}${plainDeclaration}`;
    const info: ParamInfo = {
      name: csParam,
      declaration: decl,
      plainDeclaration,
      property: param.param,
      replay,
    };
    (isOptional ? optionalParams : requiredParams).push(info);
  }

  if (op.parameters.body) {
    const bodyInfo = op.parameters.body;
    let bodyType = resolveBodyParamType(
      bodyInfo,
      program,
      models,
      enums,
      usedHelpers,
    );

    // A bulk or nullable body (`Widget[]`, `Record<Widget>`, `Widget | null`) is
    // filtered through to its element model, so a property hidden from the request (a
    // read-only `id`) is not sent for each item either.
    const { element, wrappers } = unwrapType(bodyInfo.type);
    if (
      bodyInfo.bodyKind === "single" &&
      element.kind === "Model" &&
      (op.verb === "post" || op.verb === "patch" || op.verb === "put")
    ) {
      const bodyModel = element;
      if (bodyModel.name && !isSynthesizedMergePatchModel(program, bodyModel)) {
        const visibility = resolveRequestVisibility(
          program,
          op.operation,
          op.verb,
        );
        // A model in a `@discriminator` hierarchy is filtered as a whole hierarchy,
        // so the caller can still pass any subtype and its discriminator is written;
        // a single flat record would lose both. A model nested in the body is
        // filtered too, so a read-only property is not sent at any depth.
        const needing = findRequestModels(
          program,
          bodyModel,
          visibility,
          version,
        );
        if (needing.length > 0) {
          const records = needing.map((model) => {
            const props = filterPropsForRequest(
              model,
              visibility,
              version,
              program,
            );
            const writes = [...props.values()]
              .flatMap((prop) => modelsWrittenBy(program, prop.type))
              .filter((m) => needing.includes(m));
            return {
              model,
              doc: docText(program, model),
              access: getAccess(program, model) ?? "public",
              props,
              visibility,
              writes: new Set(writes),
              discriminated:
                findDiscriminatedRoot(program, model) !== undefined,
            };
          });
          const suffix = claimRequestTypes(
            program,
            op,
            baseMethodName,
            records,
            requestTypes,
          );
          if (suffix === undefined) return undefined;
          bodyType = wrapBody(
            requestRecordName(program, bodyModel, suffix),
            wrappers,
          );
        }
      }
    }

    const contentTypes = bodyInfo.contentTypes;
    // A request whose payload cannot be sent was reported by findUnsupportedPayload.
    const kind = classifyPayload(
      contentTypes,
      bodyInfo.type,
      "request",
      isEncodedAsText(program, bodyInfo),
    ) as PayloadKind;
    // The content is written in the format of the Content-Type the method declares
    // (see ClientRuntime.WireContent); JSON as `application/json` needs no header.
    const contentType =
      kind === "json"
        ? jsonMediaType(contentTypes)
        : (contentTypes[0] ??
          (kind === "bytes" ? "application/octet-stream" : "text/plain"));
    if (contentType.toLowerCase() !== "application/json") {
      headers.push(escapeCsString(`Content-Type: ${contentType}`));
    }
    const attributes = [
      `${fx("Body", "attribute")}(${fx("BodySerializationMethod")}.Serialized, true)`,
    ];
    const wire = transportFormat(program, bodyInfo, kind);
    if (wire) attributes.push(encodedAttribute(wire));
    // `@body body?: Widget` may be left out, in which case no body is sent at all.
    const optionalBody = bodyInfo.property?.optional === true;
    const bodyPlainDeclaration = optionalBody
      ? `${bodyType.endsWith("?") ? bodyType : `${bodyType}?`} body = null`
      : `${bodyType} body`;
    const bodyDecl = `${attributes.map((a) => `[${a}] `).join("")}${bodyPlainDeclaration}`;
    const bodyParamInfo: ParamInfo = {
      name: "body",
      declaration: bodyDecl,
      plainDeclaration: bodyPlainDeclaration,
      property: bodyInfo.property,
    };
    if (optionalBody) {
      optionalParams.unshift(bodyParamInfo);
    } else {
      requiredParams.push(bodyParamInfo);
    }
  }

  // Lets callers append arbitrary query parameters not declared in the TypeSpec
  // contract (e.g. feature flags, tracing params) to any generated call.
  const additionalQueryParamPlainDeclaration = `${fx("Dictionary", "generic")}<string, object>? additionalQueryParameters = null`;
  const additionalQueryParam: ParamInfo = {
    name: "additionalQueryParameters",
    declaration: `[${fx("Query", "attribute")}] ${additionalQueryParamPlainDeclaration}`,
    plainDeclaration: additionalQueryParamPlainDeclaration,
  };
  optionalParams.push(additionalQueryParam);

  const allParams = [...requiredParams, ...optionalParams];
  const params = [
    ...allParams.map((p) => p.declaration),
    `${fx("CancellationToken")} cancellationToken = default`,
  ];

  const paging = buildPagingMethodView(
    op.operation,
    program,
    models,
    enums,
    usedHelpers,
    allParams,
    baseMethodName,
    methodName,
    csName,
    csNs,
    doc,
    response ? withoutNullable(response.type) : undefined,
    response?.type.endsWith("?") ?? false,
    pageBodyModel(op.responses),
  );

  return {
    doc,
    methodName,
    httpMethod: capitalize(op.verb),
    route: buildRoute(rawPath, roundTrip),
    headers,
    attributes: (response?.emptyStatuses ?? []).map(
      (args) => `ClientRuntime.EmptyStatus(${args})`,
    ),
    returnAttributes: response?.encoding
      ? [encodedAttribute(response.encoding)]
      : [],
    returnType: response
      ? `${fx("Task", "generic")}<${response.type}>`
      : fx("Task"),
    paramsText: params.join(", "),
    paging,
  };
}
/**
 * Whether a media type is JSON: `application/json`, `text/json`, or a structured
 * `+json` type such as `application/vnd.acme+json` or `application/problem+json`.
 * Line-delimited and sequence formats (`application/x-ndjson`,
 * `application/json-seq`) are not one JSON document, so they are not JSON here.
 *
 * @param mediaType - The declared media type, possibly with parameters.
 * @returns `true` when the payload is a single JSON document.
 */
function isJsonMediaType(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return (
    type === "application/json" ||
    type === "text/json" ||
    type.endsWith("+json")
  );
}

/**
 * Picks the media type a JSON body is sent with: `application/json` when the
 * operation accepts it, otherwise the first JSON media type it declares, so an API
 * that only accepts `application/vnd.acme+json` gets exactly that.
 *
 * @param contentTypes - The media types the body declares; empty means unspecified.
 * @returns The `Content-Type` to send.
 */
function jsonMediaType(contentTypes: string[]): string {
  const json = contentTypes.filter(isJsonMediaType);
  return (
    json.find((c) => c.toLowerCase() === "application/json") ??
    json[0] ??
    "application/json"
  );
}

/**
 * Whether a payload can travel as plain text: a scalar (`int32`, `boolean`,
 * `utcDateTime`, `string`, ...), a literal, an enum, or a union of those. TypeSpec
 * sends a scalar body as `text/plain` unless told otherwise, so these are written
 * with their wire text and parsed back from it. A model, list, or dictionary has no
 * text form.
 *
 * @param type - The payload's TypeSpec type.
 * @returns `true` when the value has a plain-text form.
 */
function isTextual(type: Type): boolean {
  switch (type.kind) {
    case "Scalar":
    case "String":
    case "Number":
    case "Boolean":
    case "Enum":
    case "EnumMember":
      return true;
    case "Union":
      return [...type.variants.values()].every(
        (v) =>
          (v.type.kind === "Intrinsic" && v.type.name === "null") ||
          isTextual(v.type),
      );
    default:
      return false;
  }
}

/**
 * Whether a payload is raw bytes (the `bytes` scalar, or one derived from it).
 *
 * @param type - The payload's TypeSpec type.
 * @returns `true` for bytes.
 */
function isBytes(type: Type): boolean {
  return type.kind === "Scalar" && builtinScalarName(type) === "bytes";
}

/**
 * Whether a bytes body is encoded as text: `@body @encode(BytesKnownEncoding.base64url)
 * data: bytes` is base64url text, which TypeSpec sends as `text/plain`, not raw
 * bytes. Bytes with no `@encode` are raw.
 *
 * @param program - The compiler program.
 * @param body - The request or response body.
 * @returns `true` for bytes encoded as base64 or base64url text.
 */
function isEncodedAsText(program: Program, body: HttpPayloadBody): boolean {
  if (body.bodyKind !== "single" || !body.property || !isBytes(body.type)) {
    return false;
  }
  const encoding = getEncode(program, body.property)?.encoding;
  return encoding === "base64" || encoding === "base64url";
}

/**
 * Decides how a payload travels, from its TypeSpec type and the media types it
 * declares.
 *
 * - Only JSON media types (or none): `json`.
 * - Only other media types: `bytes` for bytes, `text` for anything with a plain-text
 *   form (see {@link isTextual}), and `unsupported` for a model, list, or dictionary.
 * - Both: a request picks JSON, since the client chooses what it sends. A response is
 *   whatever the server chooses, so a textual value is `negotiated` (read by the
 *   `Content-Type` that arrives) and anything else is `unsupported`, because a model
 *   that may arrive as XML cannot be read as JSON.
 *
 * @param contentTypes - The media types the payload declares; empty means unspecified.
 * @param type - The payload's TypeSpec type.
 * @param direction - Whether the client sends or receives the payload.
 * @param encodedAsText - Whether bytes are encoded as base64 or base64url text (see
 *   {@link isEncodedAsText}), so they travel as text rather than raw.
 * @returns How the payload travels, or `unsupported`.
 */
function classifyPayload(
  contentTypes: string[],
  type: Type,
  direction: "request" | "response",
  encodedAsText = false,
): PayloadKind | "unsupported" {
  const json = contentTypes.length === 0 || contentTypes.some(isJsonMediaType);
  const other = contentTypes.some((c) => !isJsonMediaType(c));
  if (json && (!other || direction === "request")) return "json";
  if (isBytes(type) && !encodedAsText) return json ? "unsupported" : "bytes";
  if (!isTextual(type)) return "unsupported";
  return json ? "negotiated" : "text";
}

/**
 * Decides whether a body's `@encode` can be honoured, given how the body travels.
 * A plain-text body is written and read through the runtime encoder, so every
 * scalar format works there (a number as a string is already a string). A JSON
 * body has no property to carry a converter or `JsonNumberHandling`, so only the
 * default format works, and a delimited list has no text form of its own.
 *
 * @param program - The compiler program.
 * @param body - The request or response body.
 * @param kind - How the body travels.
 * @returns Whether it can be honoured, the runtime format to apply, and the
 *   encoding's name for a diagnostic.
 */
function bodyEncoding(
  program: Program,
  body: HttpPayloadBody,
  kind: PayloadKind | "unsupported",
): { ok: boolean; wire?: WireEncoding; encoding?: string } {
  const prop = body.bodyKind === "single" ? body.property : undefined;
  if (!prop) return { ok: true };
  const { support, wire, encoding } = classifyEncoding(program, prop);
  switch (support) {
    case "default":
      return { ok: true };
    case "number-as-string":
      return { ok: kind === "text", encoding };
    case "wire":
      return kind === "text" && !isDelimited(wire!)
        ? { ok: true, wire }
        : { ok: false, encoding };
    default:
      return { ok: false, encoding };
  }
}

/**
 * The wire format the runtime must be told about for a body or response: the
 * body's `@encode` when the runtime implements it, and `Base64` for bytes encoded
 * as base64 text. Base64 is the default format of bytes inside JSON, so it is no
 * `@encode` of its own, but a bytes body declared with it travels as text under the
 * media type TypeSpec gives bytes (`application/octet-stream`), which the runtime
 * would otherwise send and read raw.
 *
 * @param program - The compiler program.
 * @param body - The request or response body.
 * @param kind - How the body travels.
 * @returns The runtime format, or `undefined` when it needs none.
 */
function transportFormat(
  program: Program,
  body: HttpPayloadBody,
  kind: PayloadKind,
): WireEncoding | undefined {
  const wire = bodyEncoding(program, body, kind).wire;
  if (wire) return wire;
  return kind === "text" &&
    isEncodedAsText(program, body) &&
    body.bodyKind === "single" &&
    getEncode(program, body.property!)?.encoding === "base64"
    ? "Base64"
    : undefined;
}
/** How a method reads its result from the operation's success responses. */
interface ResolvedResponse {
  /**
   * C# type the body is read as, e.g. `"Widget"` or `"List<Widget>"`; nullable when
   * another success response has no body.
   */
  type: string;
  /** How the body travels: JSON, raw bytes, plain text, or by the `Content-Type` that arrives. */
  kind: PayloadKind;
  /** The runtime format of a plain-text response with an `@encode`, e.g. `UnixSeconds`. */
  encoding?: WireEncoding;
  /**
   * The bodyless success statuses (`Widget | void`), as `[ClientRuntime.EmptyStatus]`
   * arguments, for which the method returns `null` without reading the content.
   */
  emptyStatuses: string[];
}

/**
 * Determines how an operation's result is read from its success (2xx) responses.
 *
 * Every success response is considered, not just the first: when they carry
 * different bodies (a 200 `Item` and a 201 `CreatedItem`) the result is a
 * `JsonElement` holding whichever arrived, as for a union of models, rather than
 * every response being read as the first one's type. When some success response
 * has no body (`Widget | void`), the result is nullable. Combinations that cannot be
 * read correctly were reported by {@link findUnsupportedPayload}.
 *
 * @param responses - The operation's HTTP responses.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The resolved response, or `undefined` when no success response carries a body.
 */
function resolveResponse(
  responses: HttpOperationResponse[],
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): ResolvedResponse | undefined {
  const bodies = successBodies(responses);
  if (bodies.length === 0) return undefined;

  // `Widget | void` is a 200 with a body and a 204 without one, so the result is
  // absent whenever the server takes the empty path, and the C# type says so.
  const emptyResponses = responses.filter(
    (resp) =>
      isSuccessStatus(resp.statusCodes) &&
      (resp.responses.length === 0 || resp.responses.every((c) => !c.body)),
  );
  const mayBeEmpty = emptyResponses.length > 0;
  const emptyStatuses = emptyStatusArguments(responses, emptyResponses);
  const optional = (csType: string): string =>
    mayBeEmpty && !csType.endsWith("?") ? `${csType}?` : csType;

  // Every body is mapped, so the models of each are generated and can be read from
  // the JsonElement with Deserialize<T>. Bodies are compared by the C# type they map
  // to, so `Item` and `Item | null` are one shape (`Item?`), as are two identical
  // anonymous shapes.
  const mapped = bodies.map((body) =>
    resolveBodyType(body, program, models, enums, usedHelpers),
  );
  if (new Set(mapped.map(withoutNullable)).size > 1) {
    return {
      type: optional(fx("JsonElement")),
      kind: "json",
      emptyStatuses,
    };
  }
  const anyNullable = mapped.some((csType) => csType.endsWith("?"));

  const body = bodies[0];
  const kind = classifyPayload(
    bodies.flatMap((b) => b.contentTypes),
    body.type,
    "response",
    isEncodedAsText(program, body),
  ) as PayloadKind;

  const resultType = anyNullable ? `${withoutNullable(mapped[0])}?` : mapped[0];
  return {
    type: optional(resultType),
    kind,
    encoding: transportFormat(program, body, kind),
    emptyStatuses,
  };
}
/**
 * Removes a trailing nullable marker from a C# type.
 *
 * @param csType - A C# type such as `Widget?`.
 * @returns The type without its `?`.
 */
function withoutNullable(csType: string): string {
  return csType.endsWith("?") ? csType.slice(0, -1) : csType;
}

/**
 * The model every success response of a paged operation carries as its body, which
 * the paging wrapper reads the items and the next link or token from. `Page | null`
 * and `Page | void` count as `Page`.
 *
 * @param responses - The operation's HTTP responses.
 * @returns The model, or `undefined` when the successes carry different bodies or the
 *   body is not a model (an explicit `@body items: Store[]`, for instance).
 */
function pageBodyModel(responses: HttpOperationResponse[]): Model | undefined {
  const types = new Set(
    successBodies(responses).map((b) => soleVariant(b.type)?.type ?? b.type),
  );
  if (types.size !== 1) return undefined;
  const [type] = types;
  return type.kind === "Model" && !isArrayModelType(type) && !type.indexer
    ? type
    : undefined;
}

/**
 * The declaration of a page property whose C# type the page's record has. A record is
 * flattened from its model and that model's bases, so a page redeclaring
 * `items: NarrowItem[]` has `List<NarrowItem> Items`. A model in a `@discriminator`
 * hierarchy instead derives from its base's record, which already declares the
 * property, and leaves the redeclaration out (see `buildPropertyViews`), so the base
 * record's declaration is the one it has.
 *
 * @param program - The compiler program.
 * @param pageModel - The page model, or `undefined` when there is none.
 * @param property - The paging property, wherever in the page's bases it is declared.
 * @returns The declaration the record's property is typed from.
 */
function recordProperty(
  program: Program,
  pageModel: Model | undefined,
  property: ModelProperty,
): ModelProperty {
  if (!pageModel) return property;
  // The page's record, then each record it derives from.
  const records = [pageModel];
  for (
    let base = pageModel.baseModel;
    base && findDiscriminatedRoot(program, base);
    base = base.baseModel
  ) {
    records.push(base);
  }
  // The topmost record is flattened; the ones deriving from it add only their own.
  const top = records[records.length - 1];
  const fromTop = flattenProperties(top).get(property.name);
  if (fromTop) return fromTop;
  for (let i = records.length - 2; i >= 0; i--) {
    const own = records[i].properties.get(property.name);
    if (own) return own;
  }
  return property;
}

/**
 * Reports the `unsupported-paging-style` warning for an operation whose
 * `@list` paging metadata doesn't resolve to a strategy this emitter can
 * generate a wrapper for. The raw single-page method is still generated.
 *
 * @param program - The compiler program, used to report the diagnostic.
 * @param operation - The `@list` operation.
 * @param reason - Human-readable explanation, interpolated into the message.
 */
function reportUnsupportedPaging(
  program: Program,
  operation: Operation,
  reason: string,
): void {
  program.reportDiagnostic(
    createDiagnostic({
      code: "unsupported-paging-style",
      target: operation,
      format: { operationName: operation.name, reason },
    }),
  );
}

/** Whether a resolved paging role lives directly on the page model rather than a nested sub-object. */
function isFlatPagingProperty(p: PagingProperty): boolean {
  return p.path.length <= 1;
}

/**
 * Picks a local variable name that collides with neither an already-taken name
 * (the operation's own forwarded parameters, or an earlier local allocated in
 * the same method) nor, after this call, any later one — generated loop bodies
 * reference these names verbatim, so a real collision (a parameter named
 * `token`, `page`, or `count`, all plausible TypeSpec identifiers) would
 * otherwise produce self-referential or outright non-compiling C#.
 *
 * @param base - The preferred name, e.g. `"page"`.
 * @param taken - Names already in scope; mutated to also claim the result.
 * @returns `base`, or `base` suffixed with the first free number starting at 2.
 */
function uniqueLocalName(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) {
    candidate = `${base}${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * The C# numeric literal of a parameter's declared TypeSpec default
 * (`@query @pageIndex pageIndex?: int32 = 1` → `"1"`), when it has one.
 *
 * Only a paging wrapper's own synthesized counter-seed expression consults
 * this — the raw method's own parameter still defaults to plain C# `null`
 * either way (letting Refit omit it from the request so the server applies
 * its own default), since that convention is unrelated to what starting
 * number *this* generated loop should assume when the caller omits the
 * parameter entirely.
 *
 * @param property - The operation parameter.
 * @returns The literal text, or `undefined` when there is no numeric default.
 */
function numericDefaultLiteral(property: ModelProperty): string | undefined {
  const value = property.defaultValue;
  return value?.valueKind === "NumericValue"
    ? value.value.toString()
    : undefined;
}

/**
 * Builds the {@link PagingMethodView} for an operation, when its `@list`
 * paging metadata resolves to a supported forward-iteration strategy.
 *
 * Detection follows the TypeSpec core pagination metadata exclusively —
 * `@list` + `getPagingOperation` — never a bespoke decorator or an assumed
 * field-naming convention, since this emitter is a public library with no tie
 * to any one organization's API shape.
 *
 * Priority when a page model exposes more than one forward-iteration signal is
 * `nextLink` > `continuationToken` > `offset`/`pageIndex`, since `nextLink` is
 * the most self-contained (the URL already embeds everything the next request
 * needs). `prevLink`/`firstLink`/`lastLink` are backward/random-access links,
 * not forward-iteration drivers, and never influence this selection — they
 * still render as ordinary model properties via the ordinary record codegen.
 *
 * @param operation - The TypeSpec operation (only consulted for `@list`/paging metadata).
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @param allParams - The raw method's full, ordered parameter list (required then optional).
 * @param baseMethodName - The TypeSpec-derived base operation name (e.g. `"list"`).
 * @param rawMethodName - The raw single-page method's C# name (e.g. `"ListAsync"`).
 * @param csName - Enclosing interface's C# name, used only by the `nextLink` strategy.
 * @param csNs - Enclosing interface's C# namespace, used only by the `nextLink`
 *   strategy, to qualify the named `HttpClient` so it can't collide with an
 *   identically-named interface in a different service or API version.
 * @param doc - The operation's doc comment (already unescaped), carried onto the wrapper.
 * @param rawResponseType - The raw method's own resolved response body type
 *   (e.g. `"PagedResult<Store>"`), reused verbatim as the `nextLink` strategy's
 *   continuation-page type, so it can never drift from whatever the raw method
 *   itself actually returns — regardless of which model in an inheritance chain
 *   happens to declare `@pageItems`/`@nextLink`. `undefined` (an operation with
 *   no response body) can't reach here, since `getPagingOperation` wouldn't
 *   have resolved a `pageItems` role in the first place.
 * @param pageNullable - Whether the raw method can return no page (a bodyless success).
 * @param pageModel - The model the success responses carry as their body (see {@link pageBodyModel}).
 * @returns The paging wrapper view, or `undefined` when the operation isn't
 *   `@list`, carries no usable paging metadata, or resolves to an unsupported shape
 *   (in which case a diagnostic has already been reported).
 */
function buildPagingMethodView(
  operation: Operation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
  allParams: ParamInfo[],
  baseMethodName: string,
  rawMethodName: string,
  csName: string,
  csNs: string,
  doc: string | undefined,
  rawResponseType: string | undefined,
  pageNullable: boolean,
  pageModel: Model | undefined,
): PagingMethodView | undefined {
  if (!isList(program, operation)) return undefined;

  const [pagingOp] = getPagingOperation(program, operation);
  // `pagingOp` undefined means the operation is missing `@pageItems`; the
  // compiler's own `validatePagingOperations` pass already reported that.
  if (!pagingOp) return undefined;

  if (!isFlatPagingProperty(pagingOp.output.pageItems)) {
    reportUnsupportedPaging(
      program,
      operation,
      "a nested paging property (not declared directly on the page response model)",
    );
    return undefined;
  }

  const pageItemsProp = pagingOp.output.pageItems.property;
  // Typed from the property the record exposes, which a discriminated page that
  // narrows its items does not redeclare.
  const recordItemsProp = recordProperty(program, pageModel, pageItemsProp);
  if (recordItemsProp.optional) {
    reportUnsupportedPaging(
      program,
      operation,
      "an optional (nullable) @pageItems array, which the generated loop cannot safely enumerate when the server omits it",
    );
    return undefined;
  }
  // A base can declare the property as something other than a list (`items: unknown`)
  // that a derived page narrows to `Store[]`; the record still holds the base's type.
  const itemsArrayModel = recordItemsProp.type;
  if (itemsArrayModel.kind !== "Model" || !isArrayModelType(itemsArrayModel)) {
    reportUnsupportedPaging(
      program,
      operation,
      "an items property the page's record does not hold as a list",
    );
    return undefined;
  }
  const itemType = mapType(
    itemsArrayModel.indexer.value,
    program,
    models,
    enums,
    usedHelpers,
  );
  const itemsPropertyName = toCsPropName(
    getClientName(program, recordItemsProp) ?? recordItemsProp.name,
  );

  // The page type is the raw method's own resolved response type, never
  // re-derived from wherever `@pageItems` happens to be declared: those can be
  // different models when paging properties are split across an inheritance
  // hierarchy, and only the operation's actual response type is guaranteed to
  // carry every paging property this function goes on to read off of it. An
  // anonymous or otherwise unmappable response maps to plain "object", which
  // has no `.Items`/`.Next`/etc. members to read — generating against it would
  // produce C# that cannot compile, so it's rejected outright instead. This
  // also, as a side effect, covers a paging property bound to a response
  // header rather than the JSON body: `@typespec/http` synthesizes an
  // anonymous implicit body for whatever's left over whenever any response
  // property is pulled out as a header, so `rawResponseType` is already
  // "object" by the time such a case would reach here — no separate check needed.
  const pageType = rawResponseType ?? "object";
  if (pageType === "object") {
    reportUnsupportedPaging(
      program,
      operation,
      `an anonymous or unmappable page response type (there is no named C# type to read .${itemsPropertyName} from)`,
    );
    return undefined;
  }

  // The wrapper reads every paging property off the page it got back, so each must be
  // a property of the response body: not of an envelope around an explicit `@body`, and
  // not a header.
  // Every declaration along the page's bases, including ones a redeclaration shadows:
  // the compiler reports a paging role where it is decorated, which can be a base
  // whose property the page narrows.
  const pageProperties = new Set<ModelProperty>();
  for (let model = pageModel; model; model = model.baseModel) {
    for (const property of model.properties.values())
      pageProperties.add(property);
  }
  const offBody =
    "a paging property that is not a property of the response body (an explicit @body list, or a paging header)";
  // In a `@discriminator` hierarchy the discriminator is only `[JsonPolymorphic]`
  // metadata, never a member of the record, so the wrapper has nothing to read it from.
  const discriminator = pageModel
    ? findDiscriminatedRoot(program, pageModel)?.discriminator.propertyName
    : undefined;
  const asDiscriminator =
    "a paging property that is also the page's discriminator, which the page's record has no member for";
  const unreadable = (property: ModelProperty): string | undefined =>
    !pageProperties.has(property)
      ? offBody
      : property.name === discriminator
        ? asDiscriminator
        : undefined;
  const itemsProblem = unreadable(pageItemsProp);
  if (itemsProblem) {
    reportUnsupportedPaging(program, operation, itemsProblem);
    return undefined;
  }

  const methodName = toCsPagingMethodName(baseMethodName);

  // Every local identifier the generated loop body introduces must avoid
  // colliding with a forwarded parameter name — a realistic TypeSpec operation
  // can plausibly declare a parameter literally named "token", "page", or
  // "count" — and with each other, hence the single shared `taken` set and
  // sequential allocation below (each call also claims its own result).
  const taken = new Set(allParams.map((p) => p.name));
  taken.add("cancellationToken");
  // The extension-method receiver ("this {Interface} client") is itself a
  // generated identifier just like `page`/`item`/etc., and just as capable of
  // colliding with a real TypeSpec parameter named "client".
  const receiverVarName = uniqueLocalName("client", taken);
  const pageVarName = uniqueLocalName("page", taken);
  const itemVarName = uniqueLocalName("item", taken);

  const commonDeclarations = allParams.map((p) => p.plainDeclaration);
  const cancellationDeclaration = `[${fx("EnumeratorCancellation", "attribute")}] ${fx("CancellationToken")} cancellationToken = default`;

  const base: Pick<
    PagingMethodView,
    | "doc"
    | "methodName"
    | "interfaceName"
    | "rawMethodName"
    | "itemType"
    | "pageType"
    | "pageNullable"
    | "itemsPropertyName"
    | "receiverVarName"
    | "pageVarName"
    | "itemVarName"
  > = {
    doc,
    methodName,
    interfaceName: csName,
    rawMethodName,
    itemType,
    pageType,
    pageNullable,
    itemsPropertyName,
    receiverVarName,
    pageVarName,
    itemVarName,
  };

  const nextLink = pagingOp.output.nextLink;
  if (nextLink) {
    if (!isFlatPagingProperty(nextLink)) {
      reportUnsupportedPaging(
        program,
        operation,
        "a nested paging property (not declared directly on the page response model)",
      );
      return undefined;
    }
    const recordNextLink = recordProperty(
      program,
      pageModel,
      nextLink.property,
    );
    const nextLinkPropertyName = toCsPropName(
      getClientName(program, recordNextLink) ?? recordNextLink.name,
    );
    const nextLinkProblem = unreadable(nextLink.property);
    if (nextLinkProblem) {
      reportUnsupportedPaging(program, operation, nextLinkProblem);
      return undefined;
    }
    // The link is resolved with `new Uri(baseAddress, link)`, which takes a string or a
    // Uri; a link formatted as anything else (`@format("uuid")`) cannot be followed.
    const nextLinkType = mapPropertyType(
      recordNextLink,
      program,
      models,
      enums,
      usedHelpers,
    ).replace(/\?$/, "");
    if (nextLinkType !== "string" && nextLinkType !== fx("Uri")) {
      reportUnsupportedPaging(
        program,
        operation,
        `a next link that is neither a string nor a URL (it maps to ${nextLinkType})`,
      );
      return undefined;
    }
    const nextLinkIsString = nextLinkType === "string";

    // Query parameters are presumed to be baked into the link by the server, as the
    // nextLink contract has it; headers and cookies are not, so they are replayed.
    const replayOptions = allParams.flatMap((p) =>
      p.replay
        ? [
            {
              key: `ClientRuntime.${p.replay.prefix} + "${escapeCsString(p.replay.name)}"`,
              value: p.replay.wire
                ? `ClientRuntime.Encode(${p.name}, ClientRuntime.WireEncoding.${p.replay.wire})`
                : p.name,
            },
          ]
        : [],
    );

    const httpClientFactoryVarName = uniqueLocalName(
      "httpClientFactory",
      taken,
    );
    return {
      ...base,
      strategy: "nextLink",
      paramsDeclaration: [
        `this ${csName} ${receiverVarName}`,
        `${fx("IHttpClientFactory")} ${httpClientFactoryVarName}`,
        ...commonDeclarations,
        cancellationDeclaration,
      ].join(", "),
      callArgNames: [...allParams.map((p) => p.name), "cancellationToken"],
      nextLinkPropertyName,
      nextLinkIsString,
      // Its own name: the continuation client does not follow redirects, unlike the
      // interface's Refit client.
      httpClientName: `${csNs}.${csName}.NextLinks`,
      httpClientFactoryVarName,
      httpClientVarName: uniqueLocalName("httpClient", taken),
      baseAddressVarName: uniqueLocalName("baseAddress", taken),
      serializerVarName: uniqueLocalName("serializer", taken),
      nextLinkVarName: uniqueLocalName("nextLink", taken),
      nextUriVarName: uniqueLocalName("nextUri", taken),
      requestVarName: uniqueLocalName("request", taken),
      responseVarName: uniqueLocalName("response", taken),
      nextPageVarName: uniqueLocalName("nextPage", taken),
      redirectsVarName: uniqueLocalName("redirects", taken),
      locationVarName: uniqueLocalName("location", taken),
      replayOptions,
    };
  }

  const continuationToken = pagingOp.output.continuationToken;
  if (continuationToken) {
    if (!isFlatPagingProperty(continuationToken)) {
      reportUnsupportedPaging(
        program,
        operation,
        "a nested paging property (not declared directly on the page response model)",
      );
      return undefined;
    }
    const tokenProblem = unreadable(continuationToken.property);
    if (tokenProblem) {
      reportUnsupportedPaging(program, operation, tokenProblem);
      return undefined;
    }
    const inputToken = pagingOp.input.continuationToken;
    const inputParam = inputToken
      ? allParams.find((p) => p.property === inputToken.property)
      : undefined;
    if (!inputParam) {
      reportUnsupportedPaging(
        program,
        operation,
        "a continuationToken output with no matching input parameter to feed it back into",
      );
      return undefined;
    }
    // The loop seeds, refreshes, and ends on the token as a string; a token typed as a
    // `Guid` or `Uri` (`@format("uuid")`) would not compile there.
    const isString = (property: ModelProperty): boolean =>
      mapPropertyType(property, program, models, enums, usedHelpers).replace(
        /\?$/,
        "",
      ) === "string";
    if (
      !isString(
        recordProperty(program, pageModel, continuationToken.property),
      ) ||
      !isString(inputToken!.property)
    ) {
      reportUnsupportedPaging(
        program,
        operation,
        "a continuationToken that is not a string on both the request and the response",
      );
      return undefined;
    }
    const recordToken = recordProperty(
      program,
      pageModel,
      continuationToken.property,
    );
    const continuationTokenPropertyName = toCsPropName(
      getClientName(program, recordToken) ?? recordToken.name,
    );
    const tokenVarName = uniqueLocalName("token", taken);
    return {
      ...base,
      strategy: "continuationToken",
      paramsDeclaration: [
        `this ${csName} ${receiverVarName}`,
        ...commonDeclarations,
        cancellationDeclaration,
      ].join(", "),
      callArgNames: [
        ...allParams.map((p) => (p === inputParam ? tokenVarName : p.name)),
        "cancellationToken",
      ],
      continuationTokenPropertyName,
      continuationTokenSeedExpression: inputParam.name,
      tokenVarName,
    };
  }

  const offsetInput = pagingOp.input.offset;
  const pageIndexInput = pagingOp.input.pageIndex;
  const counterInput = offsetInput ?? pageIndexInput;
  const counterStrategy:
    Extract<PagingStrategy, "offset" | "pageIndex"> | undefined = offsetInput
    ? "offset"
    : pageIndexInput
      ? "pageIndex"
      : undefined;
  if (counterInput && counterStrategy) {
    if (!isFlatPagingProperty(counterInput)) {
      reportUnsupportedPaging(
        program,
        operation,
        "a nested paging property (not declared directly on the operation's parameters)",
      );
      return undefined;
    }
    const inputParam = allParams.find(
      (p) => p.property === counterInput.property,
    );
    if (!inputParam) {
      reportUnsupportedPaging(
        program,
        operation,
        `an ${counterStrategy} input parameter that could not be matched to a generated method parameter`,
      );
      return undefined;
    }
    const counterVarName = uniqueLocalName(
      counterStrategy === "offset" ? "currentOffset" : "currentPageIndex",
      taken,
    );
    const countVarName = uniqueLocalName("count", taken);
    // When the caller omits the parameter, the raw method's own C# parameter
    // still defaults to plain `null` (so Refit leaves it off the wire and the
    // server applies its own default) — but *this* generated loop needs a
    // concrete number to start counting from regardless, so it falls back to
    // the parameter's declared TypeSpec default when it has one (honoring,
    // say, a documented 1-based `pageIndex`), and to 0 only otherwise.
    const counterSeedExpression = counterInput.property.optional
      ? `${inputParam.name} ?? ${numericDefaultLiteral(counterInput.property) ?? "0"}`
      : inputParam.name;
    // The per-page item count is always a plain `int`, but the counter can be
    // any integer scalar the author declared (`@offset offset: uint64`, for
    // instance) — C# has no built-in `+=` between an unrelated integer type
    // and a non-constant `int`, so `offset`'s advance step casts the count to
    // match (`pageIndex`'s `++` needs no such cast; it works on any numeric type).
    const counterCsType = mapPropertyType(
      counterInput.property,
      program,
      models,
      enums,
      usedHelpers,
    );
    return {
      ...base,
      strategy: counterStrategy,
      paramsDeclaration: [
        `this ${csName} ${receiverVarName}`,
        ...commonDeclarations,
        cancellationDeclaration,
      ].join(", "),
      counterCsType,
      callArgNames: [
        ...allParams.map((p) => (p === inputParam ? counterVarName : p.name)),
        "cancellationToken",
      ],
      counterVarName,
      counterSeedExpression,
      countVarName,
    };
  }

  reportUnsupportedPaging(
    program,
    operation,
    "no recognized forward-iteration signal (prevLink/firstLink/lastLink and pageSize alone don't drive iteration)",
  );
  return undefined;
}

/**
 * The C# type a body maps to, ignoring nullability, used to tell whether two
 * success responses carry the same shape. Mapped with throwaway accumulators, since
 * this only compares and must not add anything to the output.
 *
 * @param body - The body.
 * @param program - The compiler program.
 * @returns The C# type without a trailing `?`.
 */
export function bodyShape(body: SingleBody, program: Program): string {
  return withoutNullable(
    resolveBodyType(body, program, new Map(), new Map(), new Set()),
  );
}

/** A body that is a single payload, which is every body that reaches the mapping. */
export type SingleBody = HttpPayloadBody & { bodyKind: "single" };

/**
 * Lists the bodies of an operation's success (2xx) responses, leaving out
 * responses with no body.
 *
 * @param responses - The operation's HTTP responses.
 * @returns The single-payload bodies, in declaration order.
 */
export function successBodies(
  responses: HttpOperationResponse[],
): SingleBody[] {
  const bodies: SingleBody[] = [];
  for (const resp of responses) {
    if (!isSuccessStatus(resp.statusCodes)) continue;
    for (const content of resp.responses) {
      const body = content.body;
      if (body?.bodyKind !== "single") continue;
      if (body.type.kind === "Intrinsic" && body.type.name === "void") continue;
      bodies.push(body);
    }
  }
  return bodies;
}

/**
 * Resolves the C# type of an HTTP payload body. A body declared by a property
 * (`@body @format("uuid") id: string`) is mapped through that property, so its
 * `@format` and `@encode` apply as they would to any other property.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression for the body.
 */
function resolveBodyType(
  body: SingleBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  return body.property?.type === body.type
    ? mapPropertyType(body.property, program, models, enums, usedHelpers)
    : mapType(body.type, program, models, enums, usedHelpers);
}

/**
 * Resolves the C# type of a request body *parameter*: the body type, with a
 * merge-patch body taken as `IMergePatch<T>`, which every `MergePatch<T>` builder
 * implements.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 * @returns The C# type expression for the body parameter.
 */
function resolveBodyParamType(
  body: HttpPayloadBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): string {
  if (body.bodyKind !== "single") return "object";
  // A scalar body declared by a property carries that property's `@format` and `@encode`.
  const mapped =
    body.type.kind === "Scalar" && body.property?.type === body.type
      ? mapPropertyType(body.property, program, models, enums, usedHelpers)
      : mapType(body.type, program, models, enums, usedHelpers);
  const mergePatch = `${MERGE_PATCH_HELPER_NAME}<`;
  return mapped.startsWith(mergePatch)
    ? `${MERGE_PATCH_INTERFACE_NAME}<${mapped.slice(mergePatch.length)}`
    : mapped;
}
/**
 * Whether a response status code is a success (2xx). A wildcard is not.
 *
 * @param statusCodes - The response's status code or range.
 * @returns `true` for a status code, or a range that lies within 200-299.
 */
function isSuccessStatus(
  statusCodes: HttpOperationResponse["statusCodes"],
): boolean {
  if (statusCodes === "*") return false;
  if (typeof statusCodes === "number") {
    return statusCodes >= 200 && statusCodes < 300;
  }
  return statusCodes.start >= 200 && statusCodes.end < 300;
}

/**
 * Finds a request or success-response body the client cannot send or read
 * correctly, which would otherwise be sent or read in the wrong format with no sign
 * of it:
 *
 * - A multipart or file (`Http.File`) body.
 * - A model, list, or dictionary declared only with non-JSON media types.
 * - A response that may arrive in a media type the client cannot read as its type,
 *   such as a model declared as `application/json` or `application/xml`.
 * - Success responses with different bodies that are not all JSON, since the result
 *   can only be held as a `JsonElement`.
 *
 * A nested discriminator is also reported as `unsupported-nested-discriminator`,
 * which says how to change the model.
 *
 * @param op - The HTTP operation.
 * @param program - The compiler program.
 * @returns A description of the unsupported feature, or `undefined` when all is supported.
 */
function findUnsupportedPayload(
  op: HttpOperation,
  program: Program,
): string | undefined {
  const body = op.parameters.body;
  if (body && body.bodyKind !== "single") {
    return body.bodyKind === "multipart"
      ? "A multipart request body"
      : "A file request body (Http.File)";
  }
  if (
    body &&
    classifyPayload(
      body.contentTypes,
      body.type,
      "request",
      isEncodedAsText(program, body),
    ) === "unsupported"
  ) {
    return `A request body sent as ${body.contentTypes.join(", ")} that is not bytes or text`;
  }
  for (const response of op.responses) {
    if (!isSuccessStatus(response.statusCodes)) continue;
    for (const content of response.responses) {
      if (content.body && content.body.bodyKind !== "single") {
        return content.body.bodyKind === "multipart"
          ? "A multipart response body"
          : "A file response body (Http.File)";
      }
    }
  }

  const bodies = successBodies(op.responses);
  const kinds = bodies.map((b) =>
    classifyPayload(
      b.contentTypes,
      b.type,
      "response",
      isEncodedAsText(program, b),
    ),
  );
  const unreadable = bodies.find((_, i) => kinds[i] === "unsupported");
  if (unreadable) {
    return unreadable.contentTypes.some(isJsonMediaType)
      ? `A response body that may arrive as ${unreadable.contentTypes.join(" or ")}, which the client cannot read in every one of them`
      : `A response body sent as ${unreadable.contentTypes.join(", ")} that is not bytes or text`;
  }
  if (
    new Set(bodies.map((b) => bodyShape(b, program))).size > 1 &&
    kinds.some((kind) => kind !== "json")
  ) {
    return "Success responses with different bodies that are not all JSON";
  }

  // Bodies of one C# type are read by one method, in the way their media types
  // together call for (see resolveResponse). Each must travel that way: only JSON and
  // text mix, as a response read by the Content-Type that arrives. A 200 of JSON bytes
  // beside a 201 of raw octets would otherwise be generated with no way to read it.
  if (
    bodies.length > 1 &&
    new Set(bodies.map((b) => bodyShape(b, program))).size === 1
  ) {
    const combined = classifyPayload(
      bodies.flatMap((b) => b.contentTypes),
      bodies[0].type,
      "response",
      isEncodedAsText(program, bodies[0]),
    );
    const fits = (kind: PayloadKind | "unsupported"): boolean =>
      combined === "negotiated"
        ? kind === "json" || kind === "text" || kind === "negotiated"
        : kind === combined;
    if (combined === "unsupported" || !kinds.every(fits)) {
      return `Success responses of one type that travel in ways one method cannot read (${[...new Set(kinds)].join(", ")})`;
    }
  }

  // Each body's `@encode` is checked against how its own media types travel: a 201
  // whose number is `@encode("string")` inside JSON breaks reading even when the 200
  // beside it is a plain number of the same C# type.
  const encodedBodies: [SingleBody, PayloadKind | "unsupported"][] = [
    ...(body && body.bodyKind === "single"
      ? [
          [
            body,
            classifyPayload(
              body.contentTypes,
              body.type,
              "request",
              isEncodedAsText(program, body),
            ),
          ] as [SingleBody, PayloadKind | "unsupported"],
        ]
      : []),
    ...bodies.map(
      (b, i) => [b, kinds[i]] as [SingleBody, PayloadKind | "unsupported"],
    ),
  ];
  for (const [each, kind] of encodedBodies) {
    const { ok, encoding } = bodyEncoding(program, each, kind);
    if (!ok && each.property) {
      reportUnsupportedEncoding(program, each.property, "body", encoding ?? "");
      return `A body whose @encode "${encoding}" the client cannot produce or read`;
    }
  }

  // One method returns one C# type, read one way. Success responses that carry the
  // same value in different formats (a 200 duration in seconds and a 201 in
  // milliseconds) cannot both be read correctly by it.
  const formats = new Set(
    bodies.map((b, i) => {
      const { wire } = bodyEncoding(program, b, kinds[i]);
      return wire ?? "";
    }),
  );
  if (
    formats.size > 1 &&
    new Set(bodies.map((b) => bodyShape(b, program))).size === 1
  ) {
    return "Success responses that carry the same value in different @encode formats";
  }

  // A property anywhere in a payload whose `@encode` cannot be honoured would be
  // written or read in the wrong format, so the operation is left out here rather
  // than generated around a model that serializes it wrongly.
  for (const payload of [...(body ? [body] : []), ...bodies]) {
    for (const model of reachableModels(program, payload.type)) {
      const valueParameter = valueTemplateParameter(model);
      if (valueParameter !== undefined) {
        reportValueTemplate(program, model, valueParameter);
        return `A body containing "${model.name}", a template given a value for "${valueParameter}"`;
      }
      for (const prop of model.properties.values()) {
        const { support, encoding } = classifyEncoding(program, prop);
        if (support === "unsupported") {
          reportUnsupportedEncoding(program, prop, "property", encoding ?? "");
          return `A body containing "${model.name}.${prop.name}", whose @encode "${encoding}" the client cannot produce or read`;
        }
      }
    }
  }

  // A hierarchy System.Text.Json cannot read correctly is left out here, before the
  // method is generated, rather than only reported when its models are written.
  for (const payload of [...(body ? [body] : []), ...bodies]) {
    const nested = findNestedDiscriminator(program, payload.type);
    if (nested) {
      // The specific diagnostic says how to fix the model; it reads the same as the
      // one the record writer reports, so the two are merged by reportOnce.
      reportOnce(
        program,
        createDiagnostic({
          code: "unsupported-nested-discriminator",
          target: nested.model,
          format: {
            name: getClientName(program, nested.model) ?? nested.model.name,
            parent: getClientName(program, nested.parent) ?? nested.parent.name,
          },
        }),
      );
      return `A body containing "${nested.model.name}", a @discriminator model nested under "${nested.parent.name}"`;
    }
  }
  return undefined;
}

/**
 * Registers the models used by error responses (`@error` models, or any non-success
 * body), so they are generated even though no method returns them. A caller reads
 * one from a failed call with `ApiException.GetContentAsAsync<T>()`.
 *
 * @param responses - The operation's HTTP responses.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param usedHelpers - Accumulator for required helper classes (see {@link mapType}).
 */
function registerErrorModels(
  responses: HttpOperationResponse[],
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  usedHelpers: UsedHelpers,
): void {
  for (const response of responses) {
    if (isSuccessStatus(response.statusCodes)) continue;
    for (const content of response.responses) {
      if (content.body?.bodyKind === "single") {
        mapType(content.body.type, program, models, enums, usedHelpers);
      }
    }
  }
}

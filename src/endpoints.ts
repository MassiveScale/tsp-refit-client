// Endpoint (Refit interface) generation: turns each TypeSpec operation container
// into a C# `interface` of Refit-attributed methods, resolves route paths and
// parameter bindings, and collects the visibility-filtered request payload types
// referenced by write operations (rendered as records by ./models.ts).

import {
  Model,
  ModelProperty,
  Enum,
  Program,
  getDoc,
} from "@typespec/compiler";
import {
  HttpOperation,
  HttpOperationResponse,
  HttpPayloadBody,
  getQueryParamName,
  getHeaderFieldName,
  Visibility,
  isVisible,
  resolveRequestVisibility,
} from "@typespec/http";
import {
  getAvailabilityMap,
  Availability,
  Version,
} from "@typespec/versioning";
import {
  Renderer,
  RefitInterfaceView,
  MethodView,
  FileView,
} from "./renderer.js";
import { getClientName } from "./decorators.js";
import {
  mapType,
  capitalize,
  toCsMethodName,
  toCsParamName,
  escapeXml,
  sortUsings,
} from "./utils.js";
import { flattenProperties } from "./models.js";

/**
 * A visibility-filtered request payload synthesized for a write operation whose
 * body model has properties hidden in the request context. Collected while
 * building methods and rendered as a record by `buildFilteredRecord`.
 */
export interface RequestType {
  /** C# record name for the synthesized request type (e.g. `WidgetCreateRequest`). */
  name: string;
  /** Doc comment carried over from the source body model, if any. */
  doc: string | undefined;
  /** The properties visible in the request context, keyed by property name. */
  props: Map<string, ModelProperty>;
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
    if (version) {
      const avail = getAvailabilityMap(program, prop);
      if (avail) {
        const a = avail.get(version.name);
        if (a !== Availability.Added && a !== Availability.Available) continue;
      }
    }
    if (!isVisible(program, prop, visibility)) continue;
    result.set(name, prop);
  }
  return result;
}

/**
 * Stable name suffixes produced by TypeSpec HTTP's `applyMergePatchTransform`.
 * Models with these suffixes are already purpose-built request payloads and must
 * not be visibility-filtered again.
 */
const MERGE_PATCH_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

/**
 * Whether a model is a synthesized merge-patch payload (see
 * {@link MERGE_PATCH_SUFFIXES}), which should be passed through unfiltered.
 *
 * @param model - The candidate body model.
 * @returns `true` if the model's name matches a merge-patch suffix.
 */
function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name
    ? MERGE_PATCH_SUFFIXES.some((s) => model.name!.endsWith(s))
    : false;
}

/**
 * Whether a body model has at least one property hidden in the given request
 * context — i.e. a dedicated request type is needed instead of the full model.
 *
 * @param model - The request body model.
 * @param visibility - The resolved request visibility for the operation.
 * @param program - The compiler program.
 * @returns `true` if any (flattened) property is not visible.
 */
function hasHiddenProperties(
  model: Model,
  visibility: Visibility,
  program: Program,
): boolean {
  for (const [, prop] of flattenProperties(model)) {
    if (!isVisible(program, prop, visibility)) return true;
  }
  return false;
}

/**
 * Resolves the configured route prefix for a version: substitutes the
 * `{version}` token with the version value (or removes it when unversioned) and
 * collapses duplicate/trailing slashes.
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
  return resolved.replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Renders the C# Refit `interface` file for one operation container, turning
 * each operation into an attributed method.
 *
 * @param csName - Interface name (e.g. `IPets`).
 * @param csNs - C# namespace the interface is emitted into.
 * @param ops - The HTTP operations to render as methods.
 * @param doc - Optional doc comment for the interface.
 * @param access - C# access modifier (`public` / `internal`).
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator that collects synthesized request payload
 *   types discovered while building methods.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param rawRoutePrefix - The unresolved `route-prefix` option value.
 * @returns The full C# source of the generated interface file.
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
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  renderer: Renderer,
  rawRoutePrefix: string,
): string {
  const routePrefix = resolveRoutePrefix(rawRoutePrefix, version);
  const methods = ops.map((op) =>
    buildMethodView(
      op,
      program,
      models,
      enums,
      version,
      requestTypes,
      routePrefix,
    ),
  );
  const view: RefitInterfaceView = {
    interfaceName: csName,
    doc,
    access,
    methods,
  };
  const body = renderer.renderRefitInterface(view);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "Refit",
      "System.Collections.Generic",
      "System.Threading",
      "System.Threading.Tasks",
    ]),
    body,
    fileName: `${csName}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

/**
 * Builds the renderer view for a single Refit method: HTTP verb, route path,
 * return type, and the ordered parameter list (required first, then optional,
 * then an `additionalQueryParameters` bag and a trailing `CancellationToken`).
 * Path/query/header params get the appropriate Refit attributes; a write body
 * whose model has hidden properties is swapped for a synthesized request type,
 * which is registered into `requestTypes`.
 *
 * @param op - The HTTP operation to render.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @param version - The API version being emitted, or `undefined` when unversioned.
 * @param requestTypes - Accumulator for synthesized request payload types.
 * @param routePrefix - The already-resolved route prefix for this version.
 * @returns The {@link MethodView} for the operation.
 */
function buildMethodView(
  op: HttpOperation,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  version: Version | undefined,
  requestTypes: Map<string, RequestType>,
  routePrefix: string,
): MethodView {
  const verb = capitalize(op.verb);
  const rawPath = routePrefix
    ? `${routePrefix}/${op.path}`.replace(/\/+/g, "/").replace(/\/$/, "")
    : op.path;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const baseMethodName =
    getClientName(program, op.operation) ?? op.operation.name;
  const methodName = toCsMethodName(baseMethodName);
  const returnType = resolveReturnType(op.responses, program, models, enums);
  const doc = getDoc(program, op.operation);

  const requiredParams: string[] = [];
  const optionalParams: string[] = [];

  for (const param of op.parameters.parameters) {
    const csType = mapType(param.param.type, program, models, enums);
    const csParam = toCsParamName(param.param.name);
    const isOptional = param.param.optional;
    const nullSuffix = isOptional ? "?" : "";
    const defaultSuffix = isOptional ? " = null" : "";

    let paramStr: string;
    if (param.type === "query") {
      const httpName =
        getQueryParamName(program, param.param) ?? param.param.name;
      if (httpName !== param.param.name) {
        paramStr = `[AliasAs("${httpName}")] ${csType}${nullSuffix} ${csParam}${defaultSuffix}`;
      } else {
        paramStr = `${csType}${nullSuffix} ${csParam}${defaultSuffix}`;
      }
    } else if (param.type === "header") {
      const headerName = getHeaderFieldName(program, param.param);
      paramStr = `[Header("${headerName}")] ${csType}${nullSuffix} ${csParam}${defaultSuffix}`;
    } else {
      paramStr = `${csType}${nullSuffix} ${csParam}${defaultSuffix}`;
    }

    if (isOptional) {
      optionalParams.push(paramStr);
    } else {
      requiredParams.push(paramStr);
    }
  }

  if (op.parameters.body) {
    const body = op.parameters.body;
    let bodyType = resolveBodyType(body, program, models, enums);

    if (
      body.bodyKind === "single" &&
      body.type.kind === "Model" &&
      (op.verb === "post" || op.verb === "patch" || op.verb === "put")
    ) {
      const bodyModel = body.type as Model;
      if (bodyModel.name && !isSynthesizedMergePatchModel(bodyModel)) {
        const visibility = resolveRequestVisibility(
          program,
          op.operation,
          op.verb,
        );
        if (hasHiddenProperties(bodyModel, visibility, program)) {
          const suffix = requestTypeSuffix(op.verb);
          const requestTypeName = `${bodyModel.name}${suffix}Request`;
          if (!requestTypes.has(requestTypeName)) {
            requestTypes.set(requestTypeName, {
              name: requestTypeName,
              doc: getDoc(program, bodyModel),
              props: filterPropsForRequest(
                bodyModel,
                visibility,
                version,
                program,
              ),
            });
          }
          bodyType = requestTypeName;
        }
      }
    }

    requiredParams.push(`[Body] ${bodyType} body`);
  }

  // Lets callers append arbitrary query parameters not declared in the TypeSpec
  // contract (e.g. feature flags, tracing params) to any generated call.
  optionalParams.push(
    "[Query] Dictionary<string, object>? additionalQueryParameters = null",
  );

  const params = [
    ...requiredParams,
    ...optionalParams,
    "CancellationToken cancellationToken = default",
  ];

  return {
    doc: doc ? escapeXml(doc) : undefined,
    verb,
    path,
    returnType,
    methodName,
    paramsText: params.join(", "),
  };
}

/**
 * Determines the C# return type for an operation from its responses: the body
 * of the first success (2xx) response wrapped in `Task<...>`, or a bare `Task`
 * when no success response carries a body.
 *
 * @param responses - The operation's HTTP responses.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @returns The C# return type expression (`Task` or `Task<T>`).
 */
function resolveReturnType(
  responses: HttpOperationResponse[],
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): string {
  for (const resp of responses) {
    const sc = resp.statusCodes;
    const isSuccess =
      sc === "*"
        ? false
        : typeof sc === "number"
          ? sc >= 200 && sc < 300
          : sc.start >= 200 && sc.end < 300;
    if (!isSuccess) continue;

    for (const content of resp.responses) {
      if (content.body) {
        const t = resolveBodyType(content.body, program, models, enums);
        if (t !== "void") return `Task<${t}>`;
      }
    }
  }
  return "Task";
}

/**
 * Resolves the C# type of an HTTP payload body: the mapped type for a single
 * body, or `object` for multipart/other non-single bodies.
 *
 * @param body - The HTTP payload body.
 * @param program - The compiler program.
 * @param models - Accumulator for referenced named models (see {@link mapType}).
 * @param enums - Accumulator for referenced named enums (see {@link mapType}).
 * @returns The C# type expression for the body.
 */
function resolveBodyType(
  body: HttpPayloadBody,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): string {
  if (body.bodyKind === "single") {
    return mapType(body.type, program, models, enums);
  }
  return "object";
}

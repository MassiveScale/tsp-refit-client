import {
  EmitContext,
  Model,
  ModelProperty,
  Scalar,
  Enum,
  Type,
  Interface,
  Namespace,
  Program,
  getDoc,
  getFormat,
  isArrayModelType,
  isRecordModelType,
  isNullType,
  isVoidType,
  isNeverType,
  getNamespaceFullName,
  resolvePath,
  isErrorModel,
  isService,
  NoTarget,
} from "@typespec/compiler";
import {
  getAllHttpServices,
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
  getAllVersions,
  getAvailabilityMap,
  Availability,
  Version,
} from "@typespec/versioning";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createRenderer,
  Renderer,
  RecordView,
  PropertyView,
  EnumView,
  EnumMemberView,
  RefitInterfaceView,
  MethodView,
  FileView,
  CsprojView,
  ExtensionsView,
  InterfaceEntry,
  TemplateOverrides,
} from "./renderer.js";
import { EmitterOptions, createDiagnostic } from "./lib.js";
import { getClientName, getAccess } from "./decorators.js";

type OutputNameOwner = {
  label: string;
};

// ─── Entry point ────────────────────────────────────────────────────────────

export async function $onEmit(
  context: EmitContext<EmitterOptions>,
): Promise<void> {
  const { program, emitterOutputDir, options } = context;
  if (program.compilerOptions.noEmit) return;

  if (options["clean-output-dir"] !== false) {
    await deleteGcsFiles(program, emitterOutputDir);
  }

  const renderer = buildRenderer(program, options);

  const [services, diags] = getAllHttpServices(program);
  program.reportDiagnostics(diags);

  for (const service of services) {
    if (!isService(program, service.namespace)) continue;
    if (service.operations.length === 0) continue;
    await emitService(
      program,
      service.namespace,
      service.operations,
      emitterOutputDir,
      options,
      renderer,
    );
  }

  if (options["dotnet-format"] !== false) {
    runDotnetFormat(program, emitterOutputDir);
  }
}

// ─── Renderer factory ────────────────────────────────────────────────────────

function buildRenderer(program: Program, options: EmitterOptions): Renderer {
  const overrides = resolveTemplateOverrides(options.templates);
  try {
    return createRenderer(overrides);
  } catch (e) {
    program.reportDiagnostic(
      createDiagnostic({
        code: "template-load-failed",
        target: NoTarget,
        format: { message: String(e) },
      }),
    );
    return createRenderer({});
  }
}

function resolveTemplateOverrides(
  templates?: TemplateOverrides,
): TemplateOverrides {
  if (!templates) return {};
  const result: TemplateOverrides = {};
  for (const [key, val] of Object.entries(templates)) {
    if (val) {
      (result as Record<string, string>)[key] = resolve(process.cwd(), val);
    }
  }
  return result;
}

// ─── File writing helper ─────────────────────────────────────────────────────

async function fileExists(
  program: Program,
  filePath: string,
): Promise<boolean> {
  try {
    const s = await program.host.stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function writeFile(
  program: Program,
  filePath: string,
  content: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) await program.host.mkdirp(dir);
  await program.host.writeFile(filePath, content);
}

async function deleteGcsFiles(program: Program, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await program.host.readDir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolvePath(dir, entry);
      let stat;
      try {
        stat = await program.host.stat(entryPath);
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        await deleteGcsFiles(program, entryPath);
      } else if (stat.isFile() && entry.endsWith(".g.cs")) {
        await program.host.rm(entryPath);
      }
    }),
  );
}

// ─── dotnet format ───────────────────────────────────────────────────────────

function runDotnetFormat(program: Program, outputDir: string): void {
  // Skip when the output directory doesn't exist on the real filesystem
  // (e.g. in-memory test harness).
  if (!existsSync(outputDir)) return;

  const result = spawnSync("dotnet", ["format", outputDir, "--no-restore"], {
    encoding: "utf-8",
    stdio: "pipe",
  });

  if (result.error || (result.status !== null && result.status !== 0)) {
    const message =
      result.error?.message ??
      result.stderr?.trim() ??
      `exited with code ${result.status}`;
    program.reportDiagnostic(
      createDiagnostic({
        code: "dotnet-format-failed",
        target: NoTarget,
        format: { message },
      }),
    );
  }
}

// ─── Service-level orchestration ────────────────────────────────────────────

async function emitService(
  program: Program,
  serviceNs: Namespace,
  operations: HttpOperation[],
  outputDir: string,
  options: EmitterOptions,
  renderer: Renderer,
): Promise<void> {
  const nsFullName = getNamespaceFullName(serviceNs);
  const projectName = options["project-name"] ?? `${nsFullName}Client`;
  const csharpName = projectName.includes(".")
    ? projectName.substring(projectName.lastIndexOf(".") + 1)
    : projectName;
  const clientName = options["client-name"] ?? csharpName;
  const baseNs = options["root-namespace"] ?? `${nsFullName}.Client`;
  const rawNetVersion = options["net-version"] ?? "net8.0";
  const netVersionParts = rawNetVersion
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean);
  const netVersion = netVersionParts.join(";");
  const isMultiTarget = netVersionParts.length > 1;

  const rawRoutePrefix = options["route-prefix"] ?? "api/{version}";
  const nugetDescription =
    options["nuget-description"] ?? `Refit client for the ${baseNs} API`;
  const nugetTitle =
    options["nuget-title"] ??
    (options["client-name"] !== undefined ? clientName : undefined);
  const allVersions = getAllVersions(program, serviceNs) ?? [];

  const models = new Map<string, Model>();
  const enums = new Map<string, Enum>();
  const modelOutputOwners = new Map<string, OutputNameOwner>();

  // Group operations by container (Interface or Namespace)
  const byContainer = new Map<
    string,
    { name: string; container: Interface | Namespace; ops: HttpOperation[] }
  >();
  for (const op of operations) {
    const c = op.container;
    const key =
      c.kind === "Interface" ? c.name : `__ns_${(c as Namespace).name}`;
    const baseName =
      c.kind === "Interface"
        ? (getClientName(program, c) ?? c.name)
        : serviceNs.name;
    if (!byContainer.has(key))
      byContainer.set(key, { name: baseName, container: c, ops: [] });
    byContainer.get(key)!.ops.push(op);
  }

  const versions = allVersions;
  const versionsToEmit = resolveTargetVersions(program, versions, options);
  if (versionsToEmit === null) return; // diagnostic already reported

  // Use version subfolders only when explicitly emitting all versions.
  const useVersionedFolders = options["all-versions"] === true;

  if (versionsToEmit.length > 0) {
    for (const version of versionsToEmit) {
      const vDir = useVersionedFolders
        ? resolvePath(outputDir, version.value)
        : outputDir;
      const shouldAppendVersion =
        useVersionedFolders || options["version-in-namespace"] === true;
      const vNs = shouldAppendVersion
        ? `${baseNs}.${sanitizeVersionForNs(version.value)}`
        : baseNs;
      const requestTypes = new Map<string, RequestType>();
      const vInterfaceNames: string[] = [];
      for (const { name, container, ops } of byContainer.values()) {
        const vOps = ops.filter((op) => isOpInVersion(program, op, version));
        if (vOps.length === 0) continue;
        vInterfaceNames.push(`I${name}`);
        const containerDoc = getDoc(program, container);
        const containerAccess = getAccess(program, container) ?? "public";
        const content = buildInterface(
          `I${name}`,
          vNs,
          vOps,
          containerDoc,
          containerAccess,
          program,
          models,
          enums,
          version,
          requestTypes,
          renderer,
          rawRoutePrefix,
        );
        await writeFile(
          program,
          resolvePath(vDir, "Endpoints", `I${name}.g.cs`),
          content,
        );
      }
      for (const [, rt] of requestTypes) {
        const content = buildFilteredRecord(
          rt.name,
          rt.doc,
          rt.props,
          vNs,
          program,
          models,
          enums,
          renderer,
        );
        // In single-version mode, request types live alongside regular models.
        const rtDir = useVersionedFolders
          ? vDir
          : resolvePath(outputDir, "Models");
        await writeFile(
          program,
          resolvePath(rtDir, `${rt.name}.g.cs`),
          content,
        );
      }
      if (vInterfaceNames.length > 0) {
        const content = buildExtensions(
          clientName,
          vNs,
          vInterfaceNames,
          renderer,
        );
        await writeFile(
          program,
          resolvePath(vDir, `${clientName}Extensions.g.cs`),
          content,
        );
      }
    }
  } else {
    const requestTypes = new Map<string, RequestType>();
    const interfaceNames: string[] = [];
    for (const { name, container, ops } of byContainer.values()) {
      interfaceNames.push(`I${name}`);
      const containerDoc = getDoc(program, container);
      const containerAccess = getAccess(program, container) ?? "public";
      const content = buildInterface(
        `I${name}`,
        baseNs,
        ops,
        containerDoc,
        containerAccess,
        program,
        models,
        enums,
        undefined,
        requestTypes,
        renderer,
        rawRoutePrefix,
      );
      await writeFile(
        program,
        resolvePath(outputDir, "Endpoints", `I${name}.g.cs`),
        content,
      );
    }
    for (const [, rt] of requestTypes) {
      const content = buildFilteredRecord(
        rt.name,
        rt.doc,
        rt.props,
        baseNs,
        program,
        models,
        enums,
        renderer,
      );
      await writeFile(
        program,
        resolvePath(outputDir, "Models", `${rt.name}.g.cs`),
        content,
      );
    }
    if (interfaceNames.length > 0) {
      const content = buildExtensions(
        clientName,
        baseNs,
        interfaceNames,
        renderer,
      );
      await writeFile(
        program,
        resolvePath(outputDir, `${clientName}Extensions.g.cs`),
        content,
      );
    }
  }

  // Emit models and enums
  for (const [, model] of models) {
    if (!isEmittable(model, nsFullName)) continue;
    const recordFileName = getClientName(program, model) ?? model.name!;
    if (
      !tryReserveModelOutputName(
        program,
        modelOutputOwners,
        recordFileName,
        `model ${model.name!}`,
        model,
      )
    ) {
      continue;
    }
    const content = buildRecord(
      model,
      baseNs,
      program,
      models,
      enums,
      renderer,
    );
    await writeFile(
      program,
      resolvePath(outputDir, "Models", `${recordFileName}.g.cs`),
      content,
    );
  }
  for (const [, e] of enums) {
    if (!isEmittableEnum(e, nsFullName)) continue;
    const enumFileName = getClientName(program, e) ?? e.name;
    if (
      !tryReserveModelOutputName(
        program,
        modelOutputOwners,
        enumFileName,
        `enum ${e.name}`,
        e,
      )
    ) {
      continue;
    }
    const content = buildEnum(e, baseNs, program, renderer);
    await writeFile(
      program,
      resolvePath(outputDir, "Models", `${enumFileName}.g.cs`),
      content,
    );
  }

  // Emit project file
  if (options["emit-project-file"] !== false) {
    const csprojPath = resolvePath(outputDir, `${projectName}.csproj`);
    const overwrite = options["overwrite-project-file"] ?? false;
    if (overwrite || !(await fileExists(program, csprojPath))) {
      await writeFile(
        program,
        csprojPath,
        buildCsproj(
          baseNs,
          netVersion,
          isMultiTarget,
          deriveNugetVersion(allVersions, options),
          nugetDescription,
          nugetTitle,
          options,
          renderer,
        ),
      );
    }
  }
}

function tryReserveModelOutputName(
  program: Program,
  owners: Map<string, OutputNameOwner>,
  name: string,
  ownerLabel: string,
  target: Type,
): boolean {
  const existing = owners.get(name);
  if (!existing) {
    owners.set(name, { label: ownerLabel });
    return true;
  }

  program.reportDiagnostic(
    createDiagnostic({
      code: "output-name-collision",
      target,
      format: {
        name,
        first: existing.label,
        second: ownerLabel,
      },
    }),
  );
  return false;
}

// ─── NuGet version derivation ────────────────────────────────────────────────

/**
 * Attempts to parse a semver string from a TypeSpec version value.
 * Accepts an optional leading `v`/`V`, two-part (`1.2`) or three-part (`1.2.3`)
 * numeric versions, and preserves any pre-release / build-metadata suffix.
 * Returns `undefined` when the string cannot be interpreted as semver.
 */
export function tryParseSemver(value: string): string | undefined {
  const stripped = value.replace(/^[vV]/, "");
  const match = stripped.match(/^(\d+)\.(\d+)(?:\.(\d+))?([-+].+)?$/);
  if (!match) return undefined;
  const patch = match[3] ?? "0";
  const rest = match[4] ?? "";
  return `${match[1]}.${match[2]}.${patch}${rest}`;
}

/** Formats a date as a CalVer string (`YYYY.MM.DD`). */
export function toCalVer(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * Derives the NuGet `<Version>` to write into the `.csproj`.
 *
 * Priority:
 * 1. `nuget-version` option (explicit override)
 * 2. Semver parsed from the targeted TypeSpec API version
 *    - `target-version` (single-version mode) if specified
 *    - Latest declared version otherwise (covers both default single-version and all-versions)
 * 3. CalVer (`YYYY.MM.DD`) when no version is declared or semver cannot be parsed
 */
export function deriveNugetVersion(
  allVersions: Version[],
  options: EmitterOptions,
): string {
  if (options["nuget-version"]) return options["nuget-version"];

  let versionString: string | undefined;
  if (allVersions.length > 0) {
    if (options["target-version"] && options["all-versions"] !== true) {
      versionString = allVersions.find(
        (v) => v.value === options["target-version"],
      )?.value;
    }
    versionString ??= allVersions[allVersions.length - 1].value;
  }

  if (versionString) {
    const parsed = tryParseSemver(versionString);
    if (parsed) return parsed;
  }

  return toCalVer(new Date());
}

// ─── Route prefix ────────────────────────────────────────────────────────────

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

// ─── Version selection ───────────────────────────────────────────────────────

/**
 * Returns the list of versions to emit based on emitter options.
 * Returns `null` (and reports a diagnostic) when the requested version cannot be resolved.
 */
function resolveTargetVersions(
  program: Program,
  versions: Version[],
  options: EmitterOptions,
): Version[] | null {
  const targetValue = options["target-version"];

  // All-versions mode: emit every declared version (or fall through to unversioned).
  if (options["all-versions"]) {
    return versions; // may be empty for unversioned APIs
  }

  // Unversioned API: target-version is unsatisfiable.
  if (versions.length === 0) {
    if (targetValue) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: "none (API is not versioned)",
          },
        }),
      );
      return null;
    }
    return [];
  }

  // Versioned API with an explicit target.
  if (targetValue) {
    const found = versions.find((v) => v.value === targetValue);
    if (!found) {
      program.reportDiagnostic(
        createDiagnostic({
          code: "version-not-found",
          target: NoTarget,
          format: {
            version: targetValue,
            available: versions.map((v) => v.value).join(", "),
          },
        }),
      );
      return null;
    }
    return [found];
  }

  // Default: latest declared version (last in declaration order).
  return [versions[versions.length - 1]];
}

// ─── Version filtering ───────────────────────────────────────────────────────

function isOpInVersion(
  program: Program,
  op: HttpOperation,
  version: Version,
): boolean {
  const avail = getAvailabilityMap(program, op.operation);
  if (!avail) return true;
  const a = avail.get(version.name);
  return a === Availability.Added || a === Availability.Available;
}

// ─── Visibility-filtered request types ──────────────────────────────────────

interface RequestType {
  name: string;
  doc: string | undefined;
  props: Map<string, ModelProperty>;
}

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

// TypeSpec HTTP's applyMergePatchTransform produces models with these stable name suffixes.
// These models are already purpose-built request payloads and must not be filtered further.
const MERGE_PATCH_SUFFIXES = [
  "MergePatchUpdate",
  "MergePatchUpdateReplaceOnly",
  "MergePatchCreateOrUpdate",
];

function isSynthesizedMergePatchModel(model: Model): boolean {
  return model.name
    ? MERGE_PATCH_SUFFIXES.some((s) => model.name!.endsWith(s))
    : false;
}

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

// ─── C# interface generation ─────────────────────────────────────────────────

function buildInterface(
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

// ─── C# model generation ─────────────────────────────────────────────────────

function buildPropertyViews(
  props: Iterable<[string, ModelProperty]>,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
): PropertyView[] {
  const result: PropertyView[] = [];
  for (const [, prop] of props) {
    const propDoc = getDoc(program, prop);
    const csType = mapType(prop.type, program, models, enums);
    const nullable = prop.optional ? "?" : "";
    const propName = toCsPropName(getClientName(program, prop) ?? prop.name);
    const defaultVal = prop.optional ? undefined : defaultForTypeRaw(csType);
    result.push({
      doc: propDoc ? escapeXml(propDoc) : undefined,
      type: `${csType}${nullable}`,
      name: propName,
      jsonPropertyName: prop.name,
      defaultValue: defaultVal,
    });
  }
  return result;
}

function buildRecord(
  model: Model,
  csNs: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renderer: Renderer,
): string {
  const typeParams = collectTypeParams(model);
  const genericSuffix =
    typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const doc = getDoc(program, model);
  const recordName = getClientName(program, model) ?? model.name!;

  const recordView: RecordView = {
    doc: doc ? escapeXml(doc) : undefined,
    recordName,
    genericSuffix,
    access: getAccess(program, model) ?? "public",
    properties: buildPropertyViews(
      flattenProperties(model),
      program,
      models,
      enums,
    ),
  };

  const body = renderer.renderRecord(recordView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "System",
      "System.Collections.Generic",
      "System.Text.Json.Serialization",
    ]),
    body,
    fileName: `${recordName}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

function buildFilteredRecord(
  name: string,
  doc: string | undefined,
  props: Map<string, ModelProperty>,
  csNs: string,
  program: Program,
  models: Map<string, Model>,
  enums: Map<string, Enum>,
  renderer: Renderer,
): string {
  const recordView: RecordView = {
    doc: doc ? escapeXml(doc) : undefined,
    recordName: name,
    genericSuffix: "",
    access: "public",
    properties: buildPropertyViews(props, program, models, enums),
  };

  const body = renderer.renderRecord(recordView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "System",
      "System.Collections.Generic",
      "System.Text.Json.Serialization",
    ]),
    body,
    fileName: `${name}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

function flattenProperties(model: Model): Map<string, ModelProperty> {
  const props = new Map<string, ModelProperty>();
  if (model.baseModel) {
    for (const [name, prop] of flattenProperties(model.baseModel)) {
      props.set(name, prop);
    }
  }
  for (const [name, prop] of model.properties) {
    props.set(name, prop);
  }
  return props;
}

function collectTypeParams(model: Model): string[] {
  const params: string[] = [];
  for (const [, prop] of model.properties) {
    gatherTemplateParams(prop.type, params);
  }
  return [...new Set(params)];
}

function gatherTemplateParams(type: Type, out: string[]): void {
  if (type.kind === "TemplateParameter") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.push((type as any).node?.id?.sv ?? "T");
  } else if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) gatherTemplateParams(m.indexer.value, out);
    // When Array<T> is represented as a template instance (no indexer), recurse into args.
    if (m.templateMapper?.args) {
      for (const arg of m.templateMapper.args) {
        if ((arg as { entityKind?: string }).entityKind === "Type") {
          gatherTemplateParams(arg as Type, out);
        }
      }
    }
    for (const [, p] of m.properties) gatherTemplateParams(p.type, out);
  }
}

function defaultForTypeRaw(csType: string): string | undefined {
  if (csType.startsWith("List<")) return "[]";
  if (csType === "string") return "default!";
  if (csType === "byte[]") return "default!";
  if (csType === "Uri") return "default!";
  return undefined;
}

function buildEnum(
  e: Enum,
  csNs: string,
  program: Program,
  renderer: Renderer,
): string {
  const doc = getDoc(program, e);
  const enumName = getClientName(program, e) ?? e.name;

  const members: EnumMemberView[] = [];
  for (const [, member] of e.members) {
    const memberDoc = getDoc(program, member);
    const stringValue =
      typeof member.value === "string" ? member.value : member.name;
    members.push({
      doc: memberDoc ? escapeXml(memberDoc) : undefined,
      name: toCsPropName(member.name),
      memberValue: stringValue,
    });
  }

  const enumView: EnumView = {
    doc: doc ? escapeXml(doc) : undefined,
    enumName,
    access: getAccess(program, e) ?? "public",
    members,
  };

  const body = renderer.renderEnum(enumView);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "System.Runtime.Serialization",
      "System.Text.Json.Serialization",
    ]),
    body,
    fileName: `${enumName}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

// ─── C# project file ────────────────────────────────────────────────────────

function buildCsproj(
  rootNs: string,
  netVersion: string,
  isMultiTarget: boolean,
  nugetVersion: string,
  nugetDescription: string,
  nugetTitle: string | undefined,
  options: EmitterOptions,
  renderer: Renderer,
): string {
  const view: CsprojView = {
    rootNamespace: rootNs,
    netVersion,
    isMultiTarget,
    nugetDescription,
    nugetTitle,
    nugetPackageId: options["nuget-package-id"],
    nugetVersion,
    nugetAuthors: options["nuget-authors"],
    nugetTags: options["nuget-tags"],
  };
  return renderer.renderCsproj(view);
}

// ─── DI registration extension class ────────────────────────────────────────

function buildExtensions(
  serviceName: string,
  csNs: string,
  interfaceNames: string[],
  renderer: Renderer,
): string {
  const className = `${serviceName}Extensions`;
  const methodName = `Add${serviceName}`;
  const clientClassName = serviceName;
  const interfaces: InterfaceEntry[] = interfaceNames.map((name) => {
    const propertyName = name.startsWith("I") ? name.slice(1) : name;
    const paramName =
      propertyName.charAt(0).toLowerCase() + propertyName.slice(1);
    return { name, propertyName, paramName };
  });
  const view: ExtensionsView = {
    className,
    methodName,
    clientClassName,
    interfaces,
  };
  const body = renderer.renderExtensions(view);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      "Microsoft.Extensions.DependencyInjection",
      "Refit",
      "System",
      "System.Net.Http",
    ]),
    body,
    fileName: `${className}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

// ─── Type mapping ────────────────────────────────────────────────────────────

function mapType(
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

function builtinScalarName(scalar: Scalar): string {
  let current: Scalar | undefined = scalar;
  while (current) {
    if (BUILTIN_SCALARS.has(current.name)) return current.name;
    current = current.baseScalar;
  }
  return scalar.name;
}

// ─── Emission filters ────────────────────────────────────────────────────────

function isEmittable(model: Model, serviceNsName: string): boolean {
  if (!model.name) return false;
  const ns = model.namespace ? getNamespaceFullName(model.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}

function isEmittableEnum(e: Enum, serviceNsName: string): boolean {
  if (!e.name) return false;
  const ns = e.namespace ? getNamespaceFullName(e.namespace) : "";
  return (
    ns === serviceNsName || ns.startsWith(`${serviceNsName}.`) || ns === ""
  );
}

// ─── Name / formatting helpers ───────────────────────────────────────────────

function sanitizeVersionForNs(version: string): string {
  return "V" + version.replace(/^v/i, "").replace(/\./g, "_");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toCsMethodName(name: string): string {
  return capitalize(name) + "Async";
}

function toCsParamName(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function toCsPropName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sortUsings(usings: string[]): string[] {
  return [...usings].sort((a, b) => {
    const aSystem = a.startsWith("System");
    const bSystem = b.startsWith("System");
    if (aSystem && !bSystem) return -1;
    if (!aSystem && bSystem) return 1;
    return a.localeCompare(b);
  });
}

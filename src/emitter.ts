// Emitter entry point and orchestration. `$onEmit` drives the whole run;
// `emitService` coordinates the per-service pipeline, delegating the actual C#
// generation to the domain modules:
//   - ./endpoints  — Refit interfaces (+ request-type collection)
//   - ./models     — records and enums
//   - ./client     — DI extensions + aggregate client
//   - ./project    — .csproj + NuGet version
//   - ./utils      — type mapping and name/format helpers
// Everything else here is coordination: renderer setup, file IO, dotnet-format,
// output-name reservation, and version selection/filtering.

import {
  EmitContext,
  Model,
  Enum,
  Type,
  Interface,
  Namespace,
  Program,
  getDoc,
  getNamespaceFullName,
  resolvePath,
  isService,
  NoTarget,
} from "@typespec/compiler";
import { getAllHttpServices, HttpOperation } from "@typespec/http";
import {
  getAllVersions,
  getAvailabilityMap,
  Availability,
  Version,
} from "@typespec/versioning";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRenderer, Renderer, TemplateOverrides } from "./renderer.js";
import { EmitterOptions, createDiagnostic } from "./lib.js";
import { getClientName, getAccess } from "./decorators.js";
import { buildInterface, RequestType } from "./endpoints.js";
import {
  buildRecord,
  buildFilteredRecord,
  buildEnum,
  collectDerivedModels,
  isEmittable,
  isEmittableEnum,
} from "./models.js";
import { buildExtensions } from "./client.js";
import { buildCsproj, deriveNugetVersion } from "./project.js";
import { sanitizeVersionForNs } from "./utils.js";

/** Records which declaration first claimed a given output file name, for collision reporting. */
type OutputNameOwner = {
  /** Human-readable label of the claiming declaration (e.g. `model Widget`). */
  label: string;
};

/**
 * Emitter entry point invoked by the TypeSpec compiler. Cleans stale output,
 * builds the renderer, then emits every HTTP service in the program and finally
 * runs `dotnet format` (unless disabled).
 *
 * @param context - The emit context supplying the program, output dir, and options.
 */
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

/**
 * Creates the Handlebars renderer, applying any configured template overrides.
 * On failure to load an override, reports a `template-load-failed` diagnostic
 * and falls back to the built-in templates.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param options - Emitter options carrying optional template overrides.
 * @returns A ready-to-use renderer.
 */
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

/**
 * Resolves configured template override paths to absolute paths (relative to the
 * current working directory), dropping empty entries.
 *
 * @param templates - The raw template overrides from options, if any.
 * @returns A map of template name to absolute override path.
 */
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

/**
 * Whether a file exists at the given path on the compiler host.
 *
 * @param program - The compiler program (its host performs the stat).
 * @param filePath - Absolute path to check.
 * @returns `true` if the path exists and is a file.
 */
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

/**
 * Writes a file through the compiler host, creating parent directories as needed.
 *
 * @param program - The compiler program (its host performs the write).
 * @param filePath - Absolute destination path.
 * @param content - File contents to write.
 */
async function writeFile(
  program: Program,
  filePath: string,
  content: string,
): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir) await program.host.mkdirp(dir);
  await program.host.writeFile(filePath, content);
}

/**
 * Recursively deletes all `*.g.cs` files under a directory (the pre-emit
 * cleanup pass), leaving non-generated files and project files in place. A
 * missing directory is a no-op.
 *
 * @param program - The compiler program (its host performs the IO).
 * @param dir - Directory to clean, recursively.
 */
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

/**
 * Runs `dotnet format --no-restore` over the output directory to normalize the
 * generated C#. Skipped when the directory doesn't exist on the real filesystem
 * (e.g. the in-memory test harness); a non-zero exit reports a
 * `dotnet-format-failed` diagnostic rather than throwing.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param outputDir - The emitter output directory to format.
 */
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

/**
 * Emits all output for a single HTTP service: resolves options and target
 * versions, groups operations by container, then writes the Refit interfaces
 * (via {@link buildInterface}), request-type records, DI extensions, model and
 * enum files, and finally the `.csproj`. Handles both versioned (optionally
 * per-version folders) and unversioned emission.
 *
 * @param program - The compiler program.
 * @param serviceNs - The service namespace being emitted.
 * @param operations - The service's HTTP operations.
 * @param outputDir - The root emitter output directory.
 * @param options - The resolved emitter options.
 * @param renderer - Handlebars renderer used to produce file contents.
 */
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

  // A model's `derivedModels` are only discovered by walking `@discriminator`
  // hierarchies explicitly — unlike sub-models reached through a property type,
  // they may never appear as an operation parameter/return type or field type.
  collectDerivedModels(program, models);

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
      options["abstract-discriminated-base"] !== false,
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

/**
 * Reserves an output file name for a model/enum, guarding against collisions. On
 * the first claim it records the owner and returns `true`; a subsequent claim of
 * the same name reports an `output-name-collision` diagnostic and returns
 * `false` so the caller skips emitting the clashing file.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param owners - Map of already-claimed output names to their first owner.
 * @param name - The output file base name being claimed.
 * @param ownerLabel - Human-readable label of the claiming declaration.
 * @param target - The declaration, used as the diagnostic target.
 * @returns `true` if the name was free and is now reserved; `false` on collision.
 */
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

/**
 * Determines which declared versions to emit: all versions in `all-versions`
 * mode, the single `target-version` when specified, or the latest declared
 * version by default. Reports a `version-not-found` diagnostic and returns
 * `null` when an explicit `target-version` cannot be satisfied.
 *
 * @param program - The compiler program, used to report diagnostics.
 * @param versions - All declared versions in declaration order (empty when unversioned).
 * @param options - The resolved emitter options.
 * @returns The versions to emit (possibly empty for unversioned APIs), or `null`
 *   when the requested version is unresolvable.
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

/**
 * Whether an operation exists in a given API version. Operations with no
 * availability map (unversioned) are considered present in every version.
 *
 * @param program - The compiler program.
 * @param op - The HTTP operation to test.
 * @param version - The version to check membership in.
 * @returns `true` if the operation is added or available in the version.
 */
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

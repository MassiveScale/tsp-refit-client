# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.5] - 2026-05-27

### Added
- `net-version` now accepts a semicolon-separated list of Target Framework Monikers for multi-targeting (e.g. `"net8.0;net9.0"`). Single-target configs are unchanged; multi-target configs emit `<TargetFrameworks>` (plural) instead of `<TargetFramework>`.

## [1.0.0-beta.4] - 2026-05-22

### Added
- Optional (`?`) path, query, and header parameters are now emitted as nullable C# types with `= null` defaults (e.g. `@query skip?: int32` → `int? skip = null`). Optional parameters are always placed after required ones in the method signature to keep generated C# valid.

## [1.0.0-beta.3] - 2026-05-22

### Added
- `dotnet-format` emitter option (default `true`): when `true`, runs `dotnet format --no-restore` on the output directory after all files are written. Set to `false` to skip formatting. A `warning` diagnostic is reported if `dotnet format` is invoked but exits with a non-zero code.
- Aggregate client class: the extensions file now also emits a concrete `{ClientName}` class (e.g. `ApiClient`) with one strongly-typed property per TypeSpec `interface`. Callers inject the single class and call `client.Pets.ListAsync(ct)` rather than injecting each Refit interface separately. The `AddXxx(...)` extension method registers all individual Refit interfaces and the aggregate client as a transient service.

### Fixed
- Multi-line doc comments (TypeSpec `/** ... */` blocks) now emit a `/// ` prefix on every line. Previously, only the first line received the prefix, producing invalid C# for models, enums, interfaces, and operations.
- The closing `</PropertyGroup>` in the generated `.csproj` now aligns at 2-space indent, matching its opening tag. Previously, trailing whitespace from the last conditional NuGet property block caused it to be indented at 4 spaces.

## [1.0.0-beta.2] - 2026-05-21

### Changed
- All generated C# source files now use the `.g.cs` extension instead of `.cs`, following the .NET source-generator convention for auto-generated code.
- All `.g.cs` files in the emitter output directory are deleted before each emit run, preventing stale generated files from accumulating across regenerations.
- All top-level generated C# types (records, enums, interfaces, extension classes) now always include a `/// <summary>` XML doc block, with the opening and closing tags on their own lines. Previously the comment was only emitted when a `@doc` annotation was present on the TypeSpec type.
- Method-level XML doc comments in Refit interfaces now use the same multi-line `<summary>` format.

### Added
- `project-name` emitter option: overrides the full project name used for the `.csproj` filename and DI extension class (e.g. `project-name: PetStoreClient` → `PetStoreClient.csproj`, `PetStoreClientExtensions.cs`, `AddPetStoreClient(...)`). Defaults to the full TypeSpec namespace + `Client` suffix (e.g. namespace `My.Api` → `My.ApiClient`). Dots are valid in the project name; the C# class identifier uses only the final dot-separated segment.
- `client-name` emitter option: the display name for the client. Used as the DI extension class/method prefix (e.g. `client-name: PetStore` → `PetStoreExtensions.g.cs`, `AddPetStore(...)`). Also used as the default NuGet `<Title>` unless `nuget-title` is explicitly set.
- NuGet package property options: `nuget-package-id`, `nuget-version`, `nuget-authors`, `nuget-description`, `nuget-title`, `nuget-tags`. All are optional; when omitted the corresponding `<PropertyGroup>` element is not emitted (except `<Description>`, which defaults to `Refit client for the {namespace} API`).
- `version-in-namespace` emitter option (default `false`): when `true`, appends the sanitized API version to the C# namespace in single-version mode (e.g. `MyApi.Client.V2_0`). Ignored when `all-versions` is `true` — versions are always appended in that mode to keep namespaces distinct.
- `prepare` script added to `package.json` so the package builds automatically when installed directly from GitHub.
- Refit interface `@doc` annotations are now surfaced on the generated C# `public interface` declaration.

## [1.0.0-beta] - 2026-05-20

### Added
- Initial C# Refit client emitter implementation (`src/emitter.ts`):
  - Generates versioned Refit interfaces (one per TypeSpec `interface` per API version)
  - Generates C# `record` types for all models, flattening inherited base-model properties
  - Generates C# `enum` types with `[JsonConverter(typeof(JsonStringEnumConverter))]` and `[EnumMember]` string values
  - Maps TypeSpec scalar types to C# primitives (`int32` → `int`, `utcDateTime` → `DateTimeOffset`, etc.)
  - Maps `@doc` annotations to XML doc comments
  - Maps HTTP verbs to Refit attributes (`[Get]`, `[Post]`, `[Patch]`, `[Delete]`)
  - Supports path, query, header, and body parameters
  - Generates a `.csproj` targeting `net8.0` with Refit 8.x references
  - Uses `getAvailabilityMap` from `@typespec/versioning` to filter operations per API version
  - Emitter options: `root-namespace` and `net-version`
  - DI registration extension class (`{Service}ClientExtensions.cs`) generated per version (and once for unversioned APIs): exposes `Add{Service}Client(services, configureHttpClient, configureBuilder?)` which registers every Refit interface in the version. The optional `Func<IHttpClientBuilder, IHttpClientBuilder>` argument lets callers add delegating handlers, Polly policies, etc.
  - `emit-project-file` emitter option (default `true`): set to `false` to skip `.csproj` generation entirely (useful when the project file is managed outside of TypeSpec)
  - `overwrite-project-file` emitter option (default `false`): when `false` the `.csproj` is only written on first emit and never clobbers subsequent developer edits; set to `true` to always regenerate it
- Handlebars template support: all generated C# files are now rendered through overridable Handlebars templates (`file.hbs`, `record.hbs`, `enum.hbs`, `refit-interface.hbs`, `csproj.hbs`). Override any template via `tspconfig.yaml`:
  ```yaml
  options:
    "@massivescale/tsp-refit-client":
      templates:
        record: "./templates/record.hbs"
  ```
  Custom template paths are resolved relative to the TypeSpec compilation working directory. Built-in helpers: `indent` (4-space prefix), `isDefined` (not-undefined check), `eq` (strict equality).
  - `template-load-failed` diagnostic emitted when a custom template override path cannot be read
- Visibility-respecting request payload types: for `POST`, `PATCH`, and `PUT` operations whose body is a named user-defined model with restricted-visibility properties, the emitter now generates a separate `{Model}CreateRequest` / `{Model}UpdateRequest` / `{Model}ReplaceRequest` record in the version directory, containing only the properties that are writable in that context.
  - Properties marked `@visibility(Lifecycle.Read)` (e.g. server-generated `id`, `createdDateTime`) are excluded from create request types.
  - Properties marked `@visibility(Lifecycle.Read, Lifecycle.Create)` (create-only / immutable after creation) are additionally excluded from update request types.
  - Request types are version-aware: properties gated with `@added` / `@removed` are included or excluded per version.
  - TypeSpec HTTP synthesized merge-patch models (`{T}MergePatchUpdate`, `{T}MergePatchCreateOrUpdate`, `{T}MergePatchUpdateReplaceOnly`) are never double-filtered; they are passed through as-is.
  - No request type is generated when all properties are already writable in the given context.

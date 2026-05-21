# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0-beta.2] - 2026-05-21

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

### Changed
- Default target framework changed from `net9.0` to `net8.0` (LTS)

### Added
- **Handlebars template support**: all generated C# files are now rendered through overridable Handlebars templates (`file.hbs`, `record.hbs`, `enum.hbs`, `refit-interface.hbs`, `csproj.hbs`). Override any template via `tspconfig.yaml`:
  ```yaml
  options:
    "@massivescale/tsp-refit-client":
      templates:
        record: "./templates/record.hbs"
  ```
  Custom template paths are resolved relative to the TypeSpec compilation working directory. Built-in helpers: `indent` (4-space prefix), `isDefined` (not-undefined check), `eq` (strict equality).
- `handlebars ^4.7.9` runtime dependency
- `scripts/copy-templates.mjs` build script that copies `.hbs` files from `src/templates/` to `dist/templates/`
- `template-load-failed` diagnostic emitted when a custom template override path cannot be read
- `sortUsings` ordering: `System.*` namespaces always first, then alphabetical
- DI registration extension class (`{Service}ClientExtensions.cs`) generated per version (and once for unversioned APIs): exposes `Add{Service}Client(services, configureHttpClient, configureBuilder?)` which registers every Refit interface in the version. The optional `Func<IHttpClientBuilder, IHttpClientBuilder>` argument lets callers add delegating handlers, Polly policies, etc.
- `extensions` template override key added alongside the other template overrides
- `emit-project-file` emitter option (default `true`): set to `false` to skip `.csproj` generation entirely (useful when the project file is managed outside of TypeSpec)
- `overwrite-project-file` emitter option (default `false`): when `false` the `.csproj` is only written on first emit and never clobbers subsequent developer edits; set to `true` to always regenerate it

- Visibility-respecting request payload types: for `POST`, `PATCH`, and `PUT` operations whose body is a named user-defined model with restricted-visibility properties, the emitter now generates a separate `{Model}CreateRequest` / `{Model}UpdateRequest` / `{Model}ReplaceRequest` record in the version directory, containing only the properties that are writable in that context.
  - Properties marked `@visibility(Lifecycle.Read)` (e.g. server-generated `id`, `createdDateTime`) are excluded from create request types.
  - Properties marked `@visibility(Lifecycle.Read, Lifecycle.Create)` (create-only / immutable after creation) are additionally excluded from update request types.
  - Request types are version-aware: properties gated with `@added` / `@removed` are included or excluded per version.
  - TypeSpec HTTP synthesized merge-patch models (`{T}MergePatchUpdate`, `{T}MergePatchCreateOrUpdate`, `{T}MergePatchUpdateReplaceOnly`) are never double-filtered; they are passed through as-is.
  - No request type is generated when all properties are already writable in the given context.
- 3 new tests covering create-request exclusions, update-request exclusions, and the no-op case


- `.github/copilot-instructions.md` as the single source of truth for project conventions, architecture, and development guidance
- `CLAUDE.md` redirecting AI assistants to `.github/copilot-instructions.md`
- `CHANGELOG.md` (this file)
- Expanded `README.md` with usage instructions, development setup, and contributing guidance
- Post-change workflow requirement: rebuild package (`npm run build && npm test`) and rebuild all TypeSpec examples after every change
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
- Added `@typespec/http`, `@typespec/versioning`, and `@typespec/rest` as dev dependencies
- Updated example `versioned-api` to reference `@massivescale/tsp-refit-client` and added `Create<T>` alias to `common.tsp`
- 9-test suite covering interface generation, model records, enums, versioning, and the `.csproj` output

## [0.1.0] - 2026-05-20

### Added
- Initial project scaffold as a TypeSpec emitter for generating C# Refit clients
- `src/lib.ts` — TypeSpec library registration via `createTypeSpecLibrary`
- `src/emitter.ts` — Emitter entry point (`$onEmit`) stub
- `src/index.ts` — Public exports (`$onEmit`, `$lib`)
- `src/testing/index.ts` — `TspRefitClientTestLibrary` for use in TypeSpec test harnesses
- `test/test-host.ts` — Test harness with `emit` and `emitWithDiagnostics` helpers
- `test/emitter.test.ts` — Initial emitter tests using Node.js native test runner
- `example/versioned-api/` — Versioned Pet Store TypeSpec API example
- TypeScript build (`tsconfig.json`), ESLint flat config (`eslint.config.js`), and Prettier config
- GitHub Actions PR validation workflow (format check, lint, build & test)
- `dependabot.yml` for automated dependency updates

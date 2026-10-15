# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-15

The first stable release, and the first published to npm. The emitter now shares its core with its sibling, `@massivescale/tsp-flurl-client`: name validation, collision reporting, version projection, visibility filtering, type mapping, `@encode` support, and the lint rule are the same code, hardened over that emitter's development, with Refit as the transport.

### Breaking

These change what generated C# compiles against or sends. Regenerate, then fix call sites as described.

- **Requests need the generated settings and handler.** Every interface must be created through `Add{Client}(...)` or the new `{Client}.Create(...)`, which install the Refit settings (`{Client}.CreateRefitSettings()`) and message handler (`{Client}.CreateHttpMessageHandler()`) from the generated `Infrastructure/ClientRuntime.g.cs`. An interface created with Refit's defaults would send enums, durations, encodings, text and bytes bodies, headers and cookies in the wrong format.
- **Header and cookie parameters** are Refit `[Property]` values written by the message handler, instead of `[Header]` attributes that sent `ToString()` (`True`, an enum's C# member name, a culture-formatted date). A `@cookie` parameter is now sent as a cookie instead of as a query parameter.
- **Unions** map to what is on the wire: `T | null` is `T?`, a union of strings is `string`, and any other union is `System.Text.Json.JsonElement`. Previously every union was `string`, which failed at runtime for anything that is not a JSON string.
- **Literal types** map to their underlying type (`"dog"` is `string`, `5` is `int`) instead of `object`. An `integer` is a `long` instead of a `double`.
- **Enums** are read and written through a converter generated for each enum (`ColorJsonConverter`) instead of `JsonStringEnumConverter`, which ignored `[EnumMember]` and sent the C# member name. Numeric members travel as JSON numbers. An unknown value throws `JsonException`, and an undeclared value in a parameter throws `ArgumentException`.
- **Durations** travel as ISO 8601 (`PT1H30M`) instead of `01:30:00`.
- **Merge-patch bodies** are `IMergePatch<T>` parameters (implemented by `MergePatch<T>`) sent as `application/merge-patch+json`. Code that passes a `MergePatch<T>` still compiles.
- **Request records** are named from the model's client name (`ProductCreateRequest` for `@clientName("Product") model Widget`), are generated for nested models, lists, dictionaries and `@discriminator` hierarchies with hidden properties, and are shared between operations only when their visible properties match; otherwise an operation gets its own (`WidgetCreateDraftRequest`).
- **`all-versions`** emits each version on its own: its endpoints, models, enums and request records in `<version>/Endpoints` and `<version>/Models` under the `<root>.V<version>` namespace, with exactly that version's shape. Previously every version shared one set of models in the root namespace.
- **Every model and enum is projected onto the emitted version**, so a property, enum member, subtype, model or enum that does not exist in it is left out, and `@renamedFrom`, `@typeChangedFrom`, `@returnTypeChangedFrom`, `@madeOptional` and `@madeRequired` are honoured.
- **`net-version`** must be `net8.0` or later.
- **Names that are not valid C#** (`@clientName("../Client")`, a backtick-quoted `` model `my model` ``, an invalid `project-name`, `client-name`, `root-namespace` or `additional-usings` entry) are reported as errors instead of being written into invalid C# or outside the output directory.
- **The aggregate client is registered with a factory** and its constructor rejects `null`; it is internal, with internal properties, when any interface is `@access(Access.internal)`.
- **Operations the client cannot send or read correctly are left out** and reported as `unsupported-feature` (multipart and file bodies, a model declared only with a non-JSON media type, success responses that cannot be read by one method) or `unsupported-encoding`, instead of being generated with the wrong behaviour.
- **Template override keys:** `client-runtime` is new; the variables passed to `refit-interface` and `extensions` changed.

### Added

- `{Client}.Create(Uri baseAddress, HttpMessageHandler? innerHandler = null)`, `{Client}.CreateRefitSettings()` and `{Client}.CreateHttpMessageHandler(...)`, for use without dependency injection.
- Every `@encode` TypeSpec defines, for model properties, query, path, header and cookie parameters, and plain-text bodies and responses: `unixTimestamp` and `rfc7231` dates, `seconds` and `milliseconds` durations, `base64url` bytes, `@encode("string")` on numbers, and `ArrayEncoding` delimited lists. A date-time header defaults to RFC 7231, as TypeSpec specifies.
- `text/plain` scalar bodies and responses are sent as their wire text and parsed back, raw `bytes` bodies and responses are sent and read raw, text is encoded with the charset its media type declares, and a response declared as both JSON and text is read by the `Content-Type` that arrives.
- A query array honours `explode`: `tags=a,b` by default, `tags=a&tags=b` with `explode: true`.
- A path parameter with `allowReserved` keeps its `/` unencoded, through Refit's round-trip placeholder (`{**path}`).
- A JSON body declared with another JSON media type (`application/vnd.acme+json`) is sent with it.
- A method whose operation can also succeed without a body returns a nullable type, which is `null` for that status; an optional body that is left out sends no body.
- Success responses with different bodies are returned as a `JsonElement`.
- `@encodedName("application/json", ...)` is honoured for property and discriminator names, a required property that allows null is written as `null`, and a property whose only value is `null` is `object?`.
- `@format("uuid")`, `@format("uri")` and `@format("url")` are honoured on a string property or parameter, not only on a scalar.
- A parameter honours `@clientName`; a path or query parameter whose wire name differs from its C# name is bound with `[AliasAs]`.
- Models used only by error responses are generated, so a failed call's body can be read with `ApiException.GetContentAsAsync<T>()`.
- New diagnostics: `invalid-option`, `invalid-name`, `name-collision`, `unsupported-feature`, `unsupported-encoding`, `unsupported-nested-discriminator`, `unsupported-generic-discriminator`, and `unsupported-value-template`.
- The `internal-access-leak` lint rule: it warns when a public operation or model references an `@access(Access.internal)` type. It follows the types the emitter writes (parameters, bodies, the model a merge patch patches, success responses, properties, template arguments, discriminated subtypes) and checks operations declared directly in a namespace.
- The `merge-patch` and `client-runtime` template override keys.
- `example/kitchen-sink` and `example/all-versions`, an end-to-end test suite (`e2e/Refit.Tests`) that runs the generated C# against a stubbed HTTP layer on .NET 8 and .NET 10, and a compile matrix (`npm run matrix`) that builds every combination of type, position, encoding, media type and awkward name with warnings as errors.
- The package is published to npm from GitHub releases (`.github/workflows/publish.yml`), with a `files` whitelist and repository metadata.

### Fixed

- Generated clients using a merge-patch body compile: the `MergePatch<T>` helper is written to `Models/MergePatch.g.cs` whenever a merge-patch body uses it (once per namespace that needs it), and a user model named `MergePatch` is reported as `output-name-collision` instead of replacing the helper. Merge patches are recognized by the compiler's metadata, not by name, so a model called `AuditMergePatchUpdate` keeps its `@clientName` and is filtered by visibility, and a value set on a patch is written with the client's serializer settings.
- A path parameter whose wire name differs from its C# name (`@path("widget-id") widgetId`) no longer makes `RestService.For` throw, and neither does a brace left in `route-prefix`, which is now percent-encoded.
- A body or property declared as a subtype or grouping model of a `@discriminator` hierarchy is sent with its discriminator. Refit hands a body to the serializer as an `object`, which System.Text.Json writes without one.
- A `bytes` body or response with `@encode(base64)` travels as base64 text, and a 200 with an empty `bytes` body is an empty array rather than `null`.
- A `bytes` body is no longer sent as base64 JSON, and a `bytes` response no longer throws `ApiException`.
- A JSON string body is sent quoted, and a JSON string response is returned without its quotes.
- Query and path values use lower-case booleans, enum wire values, ISO 8601 dates and durations, base64 bytes, and the invariant culture.
- A parameter named after a C# keyword (`params`, `event`, `class`) or `await` is escaped (`@params`), and a `Content-Type` header parameter is no longer exposed.
- Every documentation comment is XML-escaped, every wire name written as a C# string literal is escaped (every C# line break included), and option values written into the `.csproj` are XML-escaped.
- Every required reference-type property gets an initializer (`default!`, `[]` or `new()`), so generated models no longer raise `CS8618`.
- Generated code no longer suppresses the missing-documentation warning `CS1591`: every generated public type and member carries XML documentation, and the examples build with warnings as errors.
- A model or enum named after a .NET or Refit type the generated code uses (`Task`, `Uri`, `CancellationToken`, ...) no longer breaks the build; that type is written in full in that client.
- Generic records declare every template parameter of their TypeSpec declaration, and template parameters, models and enums whose names C# warns about or rejects are escaped.
- Name collisions (properties, JSON names, methods, parameters, types, files that differ only in case, version namespaces) are reported instead of emitted as uncompilable C#, and models, enums, interfaces and the aggregate client reserve their files across services, so one never silently overwrites another.
- Models and enums are collected by qualified name and operations are grouped by their declaring interface or namespace, so two declarations with the same name in different namespaces are no longer merged.
- Subtypes of a `@discriminator` model reached only through a property are generated, so `[JsonDerivedType]` never names a missing type.
- A NuGet version keeps an API version's suffix only when it is valid SemVer 2.
- `dotnet format` runs on each project in the output directory and is skipped when there is none; a failure with an empty stderr reports the exit code.
- Generated files always use LF line endings.
- `internal-access-leak`: the message no longer repeats the word "type", a parameter leak points at the parameter, and the advice names the interface or model to change. An operation marked `@access(Access.internal)` is still reported, because C# interface methods cannot carry an access modifier.

### Changed

- Bumped development dependencies to the TypeSpec 1.15.0 wave: `@typespec/compiler` and `@typespec/http` to `^1.15.0`, `@typespec/versioning` to `>=0.85.0 <1.0.0`, and raised the `peerDependencies` floor to match.
- Declared `@eslint/js` as a direct `devDependency`.
- Raised `handlebars` to `^4.7.10`, which fixes the JavaScript injection advisories (GHSA-xw65-4hp5-5hc7, GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f) in 4.7.9.
- The CI workflow runs with a read-only token, builds explicitly before testing, and compiles every example and runs the end-to-end tests and the compile matrix.

### Removed

- Dropped the `@typespec/rest` development dependency, which nothing imported.
## [1.0.0-beta.12] - 2026-07-20

### Added

- Support for `@encode("string")` on `boolean` model properties and operation parameters (new in the TypeSpec 1.14.0 wave). A boolean that travels on the wire as a JSON string (`"true"`/`"false"`) is now emitted as C# `string` instead of `bool`; plain booleans are unaffected. Other `@encode` targets (dates, durations, bytes) are still ignored — see the type-mapping notes for the remaining gap.

### Changed

- Bumped development dependencies to the TypeSpec 1.14.0 wave: `@typespec/compiler` and `@typespec/http` to `^1.14.0`, `@typespec/rest` and `@typespec/versioning` to `^0.84.0`. The `peerDependencies` floor is intentionally left at `^1.13.0` (compiler) / `^1.12.0` (http) — no 1.14.0 API is required at runtime, so consumers are not forced to upgrade.

### Removed

- **Breaking (tooling):** Removed the `./testing` package export and the `TspRefitClientTestLibrary` it exposed. It relied on `createTestLibrary`/`TypeSpecTestLibrary`, both deprecated in TypeSpec 1.14.0. Consumers writing tests against this emitter should use `createTester` from `@typespec/compiler/testing` directly (see `test/host.ts` for the pattern).

## [1.0.0-beta.11] - 2026-07-14

### Fixed

- Emission no longer crashes with `RangeError: Maximum call stack size exceeded` when models reference each other cyclically (e.g. `Pet.store: Store` and `Store.pets: Pet[]`). `gatherTemplateParams` walked model properties recursively with no cycle guard, so a mutual or self reference recursed until the stack overflowed. It now tracks visited models and stops when a model is revisited.

## [1.0.0-beta.10] - 2026-07-07

### Added

- New `abstract-discriminated-base` option (default `true`): any model in a `@discriminator` hierarchy that never resolves to a concrete wire variant — the discriminated base itself, and pass-through grouping models with no discriminator value of their own — is now emitted as `abstract record`, since it has no valid JSON shape and would throw at runtime if constructed directly. Set to `false` to keep these records concrete/instantiable.

### Fixed

- `@discriminator` base records no longer redeclare the discriminator property as a member (e.g. `Kind` on `Pet`). Doing so made `System.Text.Json` throw `InvalidOperationException` ("conflicts with an existing metadata property name") on the very first (de)serialization of the hierarchy, since the property collided with `[JsonPolymorphic]`'s `TypeDiscriminatorPropertyName`. The discriminator now lives solely in the `[JsonPolymorphic]`/`[JsonDerivedType]` attributes, matching how `@massivescale/tsp-aspnetcore-api` emits the server-side contract.

## [1.0.0-beta.8] - 2026-07-05

### Added

- `@discriminator` support: a model decorated with `@discriminator("propName")` now emits `[JsonPolymorphic(TypeDiscriminatorPropertyName = "propName")]` plus one `[JsonDerivedType(typeof(Derived), "value")]` per known derived model, so `System.Text.Json` can correctly deserialize a polymorphic base type (e.g. `List<Pet>`) into its concrete runtime types. Derived models (e.g. `Dog`, `Cat`) are now emitted as C# records that inherit from the base record (`public record Dog : Pet`) instead of flattening base properties, and are discovered and emitted even when nothing in the service references them directly — they only ever appear at runtime as a polymorphic instance of their base type, including grandchild variants reached through an intermediate model that doesn't redeclare `@discriminator` itself. The discriminator property itself is not redeclared on derived records since it's inherited from the base.
- Every generated Refit method now accepts an additional `[Query] Dictionary<string, object>? additionalQueryParameters = null` parameter, letting callers append arbitrary query parameters not declared in the TypeSpec contract to any call.

## [1.0.0-beta.7] - 2026-06-06

### Fixed

- README `@clientName` operation example now uses valid interface operation syntax (`@get list(): ...`) instead of `@get op list()`.
- `clientName` decorator library docs now explicitly document `model property` support, matching runtime behavior.
- `record.hbs` template header comment now describes access-aware output (`{{access}} record`) instead of always `public record`.

### Changed

- `@clientName(name)` now trims the provided value and reports an `invalid-client-name` diagnostic for empty/whitespace-only names.
- `@access(...)` now validates stored values at runtime and reports `invalid-access-modifier` for unsupported values.
- `getAccess()` now performs a runtime check and only returns `"public" | "internal"` when the stored value is valid.
- Emission now detects model/enum output file name collisions in `Models` (including `@clientName`-driven collisions) and reports an `output-name-collision` diagnostic instead of silently overwriting files.

## [0.7.0] - 2026-06-06

### Added

- `@clientName(name)` decorator: overrides the C# name used for a model (`record`), enum, interface (the `I` prefix is still added), operation (the `Async` suffix is still added), or model property. Import `@massivescale/tsp-refit-client` and `using MassiveScale.TspRefitClient` to use it. When applied to a model property the original TypeSpec name is still used as the `[JsonPropertyName]` wire name.
- Generated model records now emit `[JsonPropertyName("...")]` on every property, using the original TypeSpec property name as the JSON wire name. `using System.Text.Json.Serialization` is added automatically to all generated record files.
- `@access(Access.public | Access.internal)` decorator: controls the C# access modifier on emitted types (models, enums, and interfaces). Defaults to `public`. Import `@massivescale/tsp-refit-client` and `using MassiveScale.TspRefitClient` to use it.
- `clean-output-dir` emitter option (default `true`): when `true` (the existing default behaviour), all `*.g.cs` files are deleted from the output directory before emitting. Set to `false` to skip the cleanup pass.

### Fixed

- Generated Refit route attributes now always start with `/` (e.g. `[Get("/api/v1.0/items")]`). Refit 11 enforces that URL paths begin with `/`, so paths without the leading slash caused a `System.ArgumentException` at startup.

### Changed

- Upgraded generated `Refit` and `Refit.HttpClientFactory` NuGet package references from `10.*` to `11.*`.

## [1.0.0-beta.6] - 2026-05-30

### Added

- `route-prefix` emitter option (default `api/{version}`): prepends a configurable prefix to every emitted route path. The `{version}` token is replaced by the active API version value at emit time (e.g. `api/{version}` + `v1.0` → `[Get("/api/v1.0/items")]`). When no version is available the token is removed, producing `/api/items`. Set to `""` to emit paths as-is.

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
- NuGet package property options: `nuget-package-id`, `nuget-version`, `nuget-authors`, `nuget-description`, `nuget-title`, `nuget-tags`. All are optional. When omitted, `<PackageId>`, `<Authors>`, `<Title>`, and `<PackageTags>` are not emitted; `<Description>` defaults to `Refit client for the {namespace} API`; `<Version>` is auto-derived from the targeted TypeSpec API version (semver if parseable, otherwise CalVer `YYYY.MM.DD`).
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

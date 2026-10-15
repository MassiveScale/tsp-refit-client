# Project Instructions

This file is the **single source of truth** for AI assistant guidance in this repository. All project conventions, architecture notes, and development instructions live here. `CLAUDE.md` at the repo root points to this file.

---

## Project Overview

`@massivescale/tsp-refit-client` is a [TypeSpec](https://typespec.io) emitter that generates C# API clients using [Refit](https://github.com/reactiveui/refit). Given a TypeSpec definition, it produces a C# project with a Refit interface for each TypeSpec `interface`, C# records and enums for its models, and version-aware client generation.

It shares its core with [`@massivescale/tsp-flurl-client`](https://github.com/MassiveScale/tsp-flurl-client): the same options, decorators, diagnostics, versioning, model, and merge-patch behaviour, with Flurl.Http as that emitter's transport and Refit as this one's. Keep the two in step unless a difference is forced by the transport. When fixing something in the shared core (`identifiers`, `names`, `encoding`, `framework`, `decorators`, `utils`, `models`, `project`, the lint rule, or the analysis half of `endpoints`), check whether the sibling needs the same fix.

While not a dependency, this emitter is often used in conjunction with [@massivescale/tsp-aspnetcore-api](https://github.com/MassiveScale/tsp-aspnetcore-api) and supports similar implementation patterns.

---

## Commands

```powershell
npm run build          # Compile TypeScript → dist/
npm test               # Run tests (requires build first)
npm run lint           # Lint src/ and test/
npm run lint:fix       # Lint with auto-fix
npm run format         # Format all files with Prettier
npm run format:check   # Check formatting without writing
npm run watch          # Watch mode TypeScript compilation
npm run test:coverage  # Run tests under c8
npm run matrix         # Compile matrix (see below)
```

**Important:** Tests run against compiled output in `dist/`. Always run `npm run build` before `npm test`, or chain them:

```powershell
npm run build && npm test
```

To run a single test file after building:

```powershell
node --test dist/test/emitter.test.js
```

Always run `npm run format` after any change.

---

## Architecture

### TypeSpec Emitter Pattern

TypeSpec discovers this emitter via two required exports in `src/index.ts`:

- **`$lib`** (`src/lib.ts`) — Registers the library name (`"@massivescale/tsp-refit-client"`) and declares compiler diagnostics via `createTypeSpecLibrary`. Add new diagnostic codes here before using `reportDiagnostic` or `createDiagnostic`.
- **`$onEmit`** (`src/emitter.ts`) — The emitter entry point called by the TypeSpec compiler. Receives an `EmitContext` containing the program's type graph, then orchestrates the run.

### Source Layout

Generation logic is split by output domain:

- **`src/emitter.ts`** — Entry point and orchestration only: `$onEmit`, option and name validation, the per-service pipeline (`emitService`), renderer setup, file IO, `dotnet format`, output-name reservation, and version selection. Each API version is emitted as its own unit (`emitUnit`) from TypeSpec's projection of the service onto that version, with its own model and enum accumulators and its own name reservations.
- **`src/endpoints.ts`** — Refit interface generation: route resolution, parameter bindings (`[AliasAs]`, `[Query(CollectionFormat...)]`, `[Property]` for values the runtime writes), how each body and response travels (`classifyPayload`), operations the client cannot send or read (`findUnsupportedPayload`), and the visibility-filtered request records.
- **`src/models.ts`** — C# `record` and `enum` generation, including `@discriminator` polymorphic hierarchies, request-payload records, and namespace-based emission filters.
- **`src/helpers.ts`** — The hand-written C# the generated project depends on: `ClientRuntime` and `MergePatch<T>`. Written once per C# namespace.
- **`src/client.ts`** — The aggregate client class (with `Create` and the settings and handler factories) and the DI registration extension class.
- **`src/project.ts`** — `.csproj` generation and NuGet `<Version>` derivation.
- **`src/utils.ts`** — Dependency-light shared helpers: C# type mapping (`mapType`), version projection helpers, and name/formatting utilities. A leaf module.
- **`src/encoding.ts`** — How each `@encode` is produced and read, and which ones are reported.
- **`src/identifiers.ts`** / **`src/names.ts`** — C# identifier rules, name validation (`invalid-name`), and per-scope collision checks (`MemberScope`, `name-collision`).
- **`src/framework.ts`** — The .NET and Refit types the generated C# names (`FRAMEWORK_TYPES`) and `fx`, which writes each one by its short name unless a generated type of the same name would hide it, in which case it is written in full (`global::System.Type`). Templates are routed through it when they load (`qualifyTemplate`); TypeScript that writes C# calls `fx` itself. The compile matrix fails when the generated code names a type the registry is missing. A leaf module.
- **`src/renderer.ts`** — Handlebars renderer, view interfaces, and the Refit method-block renderer. **`src/decorators.ts`** — `@clientName` / `@access` decorator implementations. **`src/rules/internal-access-leak.ts`** — the lint rule.
- **`src/templates/*.hbs`** — The C# templates, copied to `dist/templates` by `scripts/copy-templates.mjs`. Each documents its variables in a header comment.

Import direction is a DAG: `utils` ← `models` ← `endpoints`; `helpers`/`client`/`project` ← `emitter`; `emitter` is the only module that imports the domain modules.

### The Refit runtime

Refit's defaults would send several TypeSpec values in the wrong format: header values through `ToString()` (`True`, an enum's C# name), query and path values in the current culture, durations as `01:30:00`, a `byte[]` body as base64 JSON, and a JSON string body unquoted. So every generated project carries `Infrastructure/ClientRuntime.g.cs` (`src/templates/client-runtime.hbs`), and every interface is created through `Add{Client}` or `{Client}.Create`, which install it:

1. **`WireUrlParameterFormatter`** (the Refit `IUrlParameterFormatter`) writes query and path values with `ToWireString`, applying a parameter's `[ClientRuntime.Encoded]` attribute.
2. **`WireContentSerializer`** (the Refit `IHttpContentSerializer`) returns a `WireContent` for every body (bodies are `[Body(BodySerializationMethod.Serialized, true)]`, so Refit buffers it rather than wrapping it). `WireContent` is written in the format of the `Content-Type` the method declares with `[Headers]`: JSON, raw bytes, or text in the declared charset. It reads responses as JSON, raw bytes, or text by the `Content-Type` that arrives.
3. **`WireHandler`** (a `DelegatingHandler`) reads Refit's `RestMethodInfo` from the request options and writes the `[Property]` values keyed with `HeaderPrefix`, `CookiePrefix` and `QueryPrefix` (headers, cookies, and query values Refit cannot write itself: bytes and newline-delimited lists), applies a text body's `@encode`, drops an optional body that was left out, returns `null` for a bodyless success status (`[ClientRuntime.EmptyStatus]`), applies a response `@encode`, and unquotes a JSON string response.

Prove a runtime change against real Refit before relying on it (the end-to-end tests below, or a scratch console app); Refit's request building has behaviour that reasoning alone gets wrong (it wraps unbuffered bodies, iterates any `IEnumerable` query value, and returns a `string` response's raw content without the serializer).

### Test Infrastructure

`test/host.ts` sets up a TypeSpec test harness using `createTester` pointed at the repo root, with `@massivescale/tsp-refit-client` as the loaded library. It exports:

- `emit(code)` — Compiles inline TypeSpec, asserts no diagnostics, returns `Record<string, string>` mapping output file paths to their string content.
- `emitWithDiagnostics(code)` — Same but also returns compiler diagnostics for testing error cases.
- `fileContent(outputs, suffix)` — Returns one emitted file's content, failing loudly if it is absent.
- `messagesFor(diagnostics, suffix)` and `has(outputs, suffix)`.

Tests use Node.js native test runner (`node:test` / `node:assert`) — no external test framework.

**End-to-end tests** live in `e2e/Refit.Tests` (MSTest.Sdk, AwesomeAssertions). They reference the C# generated from the examples and drive it through a stubbed `HttpMessageHandler`, so they prove the generated code really sends and reads each wire format. TypeScript tests can only assert on emitted text, so any change to emitted C# behaviour should be exercised there too. A stub handler must set `HttpResponseMessage.RequestMessage`, which Refit requires.

```powershell
cd example/kitchen-sink; npm install; npx tsp compile .
dotnet run --project ../../e2e/Refit.Tests -f net8.0
dotnet run --project ../../e2e/Refit.Tests -f net10.0
```

On a machine whose NuGet config includes a private feed that rejects the current credentials, add `-p:RestoreSources=https://api.nuget.org/v3/index.json` to the restore.

### Examples

- `example/simple-api/` — a small widget service.
- `example/kitchen-sink/` — most of TypeSpec at once (every scalar, unions, generics, discriminators, encodings, cookies, query styles, error models). It is compiled with warnings as errors, and its end-to-end tests cover the wire formats that are easiest to get silently wrong.
- `example/all-versions/` — versions that genuinely differ, emitted with `all-versions`. Its end-to-end tests prove each version has exactly its own shape.
- `example/versioned-api/` — a versioned Pet Store for manual end-to-end validation. Run it via `example/versioned-api/build.ps1`.

---

## Conventions

### ESM and Import Extensions

The project uses ESM (`"type": "module"`). All internal imports must use `.js` extensions — TypeScript resolves them to `.ts` at compile time, Node.js resolves to `.js` at runtime.

### TypeSpec Peer Dependency

`@typespec/compiler`, `@typespec/http` and `@typespec/versioning` are peer dependencies. Keep them in sync with the TypeSpec packages used in tests and the examples.

### Diagnostics

Declare all diagnostic codes in `src/lib.ts` inside the `diagnostics` map passed to `createTypeSpecLibrary`. Use `reportDiagnostic` (for non-fatal) or `createDiagnostic` (to return a diagnostic value) from the destructured exports of `$lib`, and `reportOnce` for anything that can be reached once per emitted version.

### Linting

ESLint uses the flat config format (`eslint.config.js`) with `typescript-eslint`. Unused variables prefixed with `_` are allowed by convention.

### Comments

Do **not** add decorative section-divider banner comments (e.g. `// ─── C# interface generation ───`). Keep inline comments to genuine explanations of non-obvious code. Rely on the file/module split — not in-file banners — to separate concerns.

### JSDoc

Every function, method, type, interface, and exported constant must have a JSDoc (`/** … */`) block describing what it is. Document parameters and return values with `@param` / `@returns` where they are not fully self-evident from the signature, and document non-obvious fields on interfaces/types. This is a hard requirement for all new and modified declarations — do not omit it.

### Report, never guess

If TypeSpec uses something the emitter cannot send or read correctly (a multipart body, a nested discriminator, an `@encode` it cannot produce), report it with a diagnostic instead of generating code that behaves differently from the spec. The cost of a loud error is a clear message; the cost of a silent one is a wrong request in production. Every such case has a diagnostic in `src/lib.ts`, a test, and a line in the README's "What is not supported".

### Line endings

Everything the emitter writes uses LF. `.gitattributes` pins LF in the repository, and the renderer normalizes template line endings on load, so a CRLF checkout or a CRLF template override cannot change the output.

### Markdown

Markdown files are excluded from Prettier (`.prettierignore`), because their tables follow the house style: pipes aligned, every cell padded to its column's width, and a separator row whose dashes fill the full width (`|------|`).

### Generated C#

Every public type and member the emitter generates carries an XML doc comment (a generated summary is used when the spec has no documentation), and every `.hbs` template does too; the generated project sets `GenerateDocumentationFile`, so a malformed `cref` or `typeparamref` surfaces as a build warning. The generated example projects must build with zero warnings.

---

## After Every Change

After making any change to the codebase:

1. **Rebuild and test the package:**

   ```powershell
   npm run build && npm test
   ```

2. **Rebuild all TypeSpec examples** and build each generated project with warnings as errors:

   ```powershell
   cd example/simple-api && npm install && npx tsp compile . && dotnet build tsp-output -warnaserror
   cd example/kitchen-sink && npm install && npx tsp compile . && dotnet build tsp-output -warnaserror
   cd example/all-versions && npm install && npx tsp compile . && dotnet build tsp-output -warnaserror
   cd example/versioned-api && npm install && ./build.ps1
   ```

   A nullable, accessibility, or XML-documentation warning in the generated C# is a defect.

3. **Run the end-to-end tests** (after compiling the examples):

   ```powershell
   dotnet run --project e2e/Refit.Tests -f net8.0
   dotnet run --project e2e/Refit.Tests -f net10.0
   ```

4. **Run the compile matrix**, which generates every combination TypeSpec accepts and requires each to be reported or to build and round-trip:

   ```powershell
   npm run matrix
   ```

   When a change deliberately leaves out more or fewer operations, accept it with `npm run matrix -- --update` and review the diff of `matrix/left-out.txt`.

All steps must pass before a change is considered complete.

## Releasing

The package is published to npm as `@massivescale/tsp-refit-client` by `.github/workflows/publish.yml`:

1. Set `version` in `package.json` and move the `CHANGELOG.md` entries from `[Unreleased]` under that version, in a pull request to `main`.
2. After it merges, publish a GitHub release from `main` whose tag is `v` plus that version (`v1.0.0`).
3. The workflow checks formatting, lint, build, and tests, verifies the tag matches `package.json`, and runs `npm publish --access public --provenance`. A prerelease version (`1.1.0-beta.1`) is published under the `beta` dist-tag, so `npm install` keeps resolving the latest stable version.

Publishing uses npm trusted publishing (GitHub OIDC), so no npm token is stored in the repository. The package's settings on npmjs.com must list this repository and `publish.yml` as a trusted publisher. npm only lets you configure a trusted publisher for a package that already exists, so the very first version has to be published once by a maintainer (`npm publish --access public` from a clean checkout of the release commit); every later release goes through the workflow.

## Maintenance

- **CLAUDE.md** — Redirects to this file. Do not add content there.
- **README.md** — User-facing documentation. Update it alongside user-visible feature changes.
- **CHANGELOG.md** — Keep a changelog following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Update it for every meaningful change.

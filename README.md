# @massivescale/tsp-refit-client

[TypeSpec](https://typespec.io) emitter for generating C# API clients using [Refit](https://github.com/reactiveui/refit).

## Summary

This emitter produces a C# project with a Refit interface for each TypeSpec `interface`, covering every `GET`, `POST`, `PUT`, `PATCH`, `DELETE` and `HEAD` operation. The generated client contains everything needed to call your API: provide the base address at runtime.

- **Wire-accurate.** Every value travels in the format the TypeSpec declares: enum wire values, ISO 8601 dates and durations, every `@encode`, `text/plain` and raw `bytes` bodies, cookies, and comma-separated or exploded query arrays. Anything the client cannot send or read correctly is reported at compile time instead of being generated wrong.
- **Version-aware.** Emit the latest version, one chosen version, or every version side by side, each with exactly its own models.
- **Plain Refit underneath.** The interfaces are ordinary Refit interfaces, so Refit's own features (`IApiResponse<T>`, `ApiException`, `IHttpClientFactory` integration) work as usual.

It is the sibling of [`@massivescale/tsp-flurl-client`](https://github.com/MassiveScale/tsp-flurl-client), which generates the same models, options and diagnostics on top of Flurl.Http.

## Usage

Add the emitter to your TypeSpec project:

```bash
npm install @massivescale/tsp-refit-client
```

Configure it in your `tspconfig.yaml`:

```yaml
emit:
  - "@massivescale/tsp-refit-client"
options:
  "@massivescale/tsp-refit-client":
    emitter-output-dir: "{output-dir}/client"
```

Then compile your TypeSpec definition:

```bash
tsp compile .
```

### Emitter options

| Option                        | Type       | Default                                       | Description                                                                                                                                                                                                                                                                                                                                                   |
|-------------------------------|------------|-----------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `project-name`                | `string`   | TypeSpec namespace + `Client`                 | Full project name for the `.csproj` filename (e.g. `PetStoreClient` → `PetStoreClient.csproj`). Dots are valid; C# identifiers use only the final segment.                                                                                                                                                                                                    |
| `client-name`                 | `string`   | Derived from `project-name`                   | Display name for the client. Controls the aggregate client class and the DI extension class/method prefix (e.g. `PetStore` → `PetStoreExtensions.g.cs`, `AddPetStore(...)`). Also used as the default NuGet `<Title>` unless `nuget-title` is set.                                                                                                            |
| `root-namespace`              | `string`   | TypeSpec namespace + `.Client`                | Overrides the root C# namespace for all generated files.                                                                                                                                                                                                                                                                                                      |
| `additional-usings`           | `string[]` | —                                             | Extra `using` directives appended to every emitted C# file, for a service that references types emitted elsewhere (for example a sibling emitter's shared namespace). Each entry must be a dotted C# namespace such as `Acme.Shared.Models`; anything else is reported as `invalid-option` and nothing is emitted.                                              |
| `net-version`                 | `string`   | `net8.0`                                      | Target .NET version(s) written into the `.csproj`: a single TFM (`net8.0`) or a semicolon-separated list (`net8.0;net9.0`). **.NET 8 or later is required**; `net7.0`, `netstandard2.0` and the like are reported as `invalid-option`. A platform suffix such as `net8.0-windows` is allowed.                                                                  |
| `target-version`              | `string`   | Latest declared version                       | Emit only this API version. Ignored when `all-versions` is `true`.                                                                                                                                                                                                                                                                                            |
| `all-versions`                | `boolean`  | `false`                                       | When `true`, generate every declared API version, each in its own subfolder and `V<version>` namespace with its own models. See [Multiple API versions](#multiple-api-versions).                                                                                                                                                                              |
| `version-in-namespace`        | `boolean`  | `false`                                       | When `true`, append the sanitized API version to the endpoint namespace in single-version mode. Has no effect when `all-versions` is `true`.                                                                                                                                                                                                                  |
| `route-prefix`                | `string`   | `api/{version}`                               | Prefix prepended to every emitted route path. `{version}` is replaced by the API version value (`api/{version}` + `v1.0` → `/api/v1.0/items`), or removed when there is none (`/api/items`). Set to `""` to disable.                                                                                                                                         |
| `emit-project-file`           | `boolean`  | `true`                                        | Set to `false` to skip `.csproj` generation.                                                                                                                                                                                                                                                                                                                  |
| `overwrite-project-file`      | `boolean`  | `false`                                       | When `false`, the `.csproj` is only written if it does not already exist.                                                                                                                                                                                                                                                                                     |
| `clean-output-dir`            | `boolean`  | `true`                                        | When `true`, all `*.g.cs` files in the output directory are deleted before emitting. Non-generated files and project files are preserved.                                                                                                                                                                                                                     |
| `abstract-discriminated-base` | `boolean`  | `true`                                        | When `true`, models in a `@discriminator` hierarchy with no concrete wire shape of their own (the discriminated base, and pass-through grouping models) are emitted as `abstract record`.                                                                                                                                                                     |
| `dotnet-format`               | `boolean`  | `true`                                        | When `true`, run `dotnet format --no-restore` on each project in the output directory after emitting (skipped when there is none).                                                                                                                                                                                                                           |
| `nuget-package-id`            | `string`   | —                                             | NuGet `<PackageId>`.                                                                                                                                                                                                                                                                                                                                          |
| `nuget-version`               | `string`   | Derived from the TypeSpec version             | NuGet `<Version>`. When not set, the targeted API version is parsed as semver (`v2.1` → `2.1.0`, `1.2-preview.1` → `1.2.0-preview.1`), otherwise CalVer (`YYYY.MM.DD`) is used. A suffix is kept only when it is valid SemVer 2.                                                                                                                              |
| `nuget-authors`               | `string`   | —                                             | NuGet `<Authors>` (comma-separated).                                                                                                                                                                                                                                                                                                                          |
| `nuget-description`           | `string`   | `Refit client for the {namespace} API`        | NuGet `<Description>`.                                                                                                                                                                                                                                                                                                                                        |
| `nuget-title`                 | `string`   | Value of `client-name` (if set), else omitted | NuGet `<Title>`.                                                                                                                                                                                                                                                                                                                                              |
| `nuget-tags`                  | `string`   | —                                             | NuGet `<PackageTags>` (space-separated).                                                                                                                                                                                                                                                                                                                      |
| `templates`                   | `object`   | —                                             | Override individual built-in Handlebars templates. Keys: `file`, `record`, `enum`, `refit-interface`, `csproj`, `extensions`, `merge-patch`, `client-runtime`.                                                                                                                                                                                               |

`project-name`, `client-name` and `root-namespace` become file paths and C# identifiers, so they are validated before anything is written. A project name must be dot-separated C# identifiers (no path separators), a client name must be a valid class name that is not a C# keyword, and a root namespace must be a valid dotted C# namespace. A bad value is reported as `invalid-option` and nothing is emitted. Values written into the `.csproj` (NuGet metadata, namespace, target framework) are XML-escaped.

### Decorators

Import the library and bring the namespace into scope to use the decorators:

```typespec
import "@massivescale/tsp-refit-client";
using MassiveScale.TspRefitClient;
```

#### `@clientName(name)`

Overrides the C# identifier used for the decorated element in the emitted output. The name must be a plain C# identifier (letters, digits and underscores, not starting with a digit), and a model, enum or interface name cannot be a C# keyword, because it becomes a type name and a file name; anything else is reported as `invalid-client-name`.

| Target           | Effect                                                                                         |
|------------------|------------------------------------------------------------------------------------------------|
| `model`          | Replaces the record name and file name (e.g. `Animal` → `Pet.g.cs` / `public record Pet`).     |
| `enum`           | Replaces the enum name and file name.                                                          |
| `interface`      | Replaces the name portion of the C# interface (the `I` prefix is still prepended).             |
| `op`             | Replaces the base method name (the `Async` suffix is still appended, first letter uppercased). |
| `model property` | Replaces the C# property or parameter name. The wire name is unchanged.                        |

```typespec
@clientName("Pet")
model Animal { id: string; }

interface Animals {
  @clientName("search")
  @get list(): Animal[];
}
```

#### Names that are not valid C#

TypeSpec lets an identifier contain almost anything once it is backtick-quoted, so the emitter checks every name it turns into a type, file, folder or member. A model, enum or interface name must be a valid C# type name (letters, digits and underscores, not starting with a digit, and not a C# keyword). A property, operation or parameter name must be a valid C# identifier. With `all-versions`, a version value must be safe as a folder name (letters, digits, dots, underscores and hyphens). A name that fails is reported as `invalid-name`, and a type with a bad name is not written. Give it a valid one with `@clientName`; the wire name is unaffected.

Different source names can also become the same C# name, which C# rejects, so collisions are reported as `name-collision` (the later declaration is left out) or, for whole types and files, `output-name-collision`:

- Properties: `foo` and `Foo`, a property that shares its record's name (`model Owner { owner: string }`, `CS0542`), or the name of a member every record has (`EqualityContract`, `Equals`, `ToString`, ...). In a `@discriminator` hierarchy, a derived property whose C# name is that of an inherited one is reported too, since C# would hide the inherited member; one that redeclares an inherited property to narrow its type is left to the inherited member.
- JSON names: two properties whose JSON names differ only in case, or that clash with an inherited property or the discriminator, which System.Text.Json rejects at runtime.
- Operations: `read` and `Read` both become `ReadAsync`. Parameters: `foo` and `Foo` both become `foo`, and a parameter cannot be named `body` (when there is a request body), `cancellationToken` or `additionalQueryParameters`, which every method already takes.
- Types: two models or enums with the same name in different child namespaces (they are flattened into one C# namespace), two interfaces with the same name, and a model named like a generated type (`IItems`, the aggregate client, its `...Extensions` class, an enum's `...JsonConverter`, `ClientRuntime`, `MergePatch`, `IMergePatch`). An interface cannot be named like the aggregate client or one of its members (`Create`, `CreateRefitSettings`, `CreateHttpMessageHandler`, `Standalone`), and `client-name` cannot be `Standalone`.
- File names that differ only in case (`Widget` and `widget`), which are the same file on Windows and macOS.
- With `all-versions`, two version values that sanitize to the same namespace segment (`1.0` and `1_0`).

Enum members have no `@clientName`, and their wire value travels separately, so an odd member name is sanitized instead (`my-member` becomes `My_member`, `2fast` becomes `_2fast`). Two members that sanitize to the same name are reported. Two members that share a wire value both write it; reading it gives the first.

Some names are fine in C# but need care, and the emitter takes it, so none of these needs `@clientName`:

- A model or enum may share its name with a .NET or Refit type the generated code uses (`Task`, `Type`, `Uri`, `CancellationToken`, `JsonElement`, `RefitSettings`, ...). The generated code then writes that type in full (`global::System.Threading.CancellationToken`), in that client only.
- A model or enum named with only lower-case letters (`thing`) is declared verbatim (`record @thing`), since C# warns about the plain name (`CS8981`).
- A template parameter that is a C# keyword or all lower-case is written verbatim (`@class`), one that is not an identifier has its other characters replaced, and one that would share a name with its record, one of its properties, or a member every record has is prefixed with `T` (`TEquals`).
- A parameter named after a keyword, or `await`, is written verbatim (`@class`, `@await`).

#### `@access(Access.public | Access.internal)`

Controls the C# access modifier on the emitted type declaration. Defaults to `public`.

```typespec
@access(Access.internal)
model InternalDto { value: string; }

@access(Access.internal)
interface SecretEndpoints {
  @get read(): InternalDto;
}
```

An internal interface is an internal property of the aggregate client, and the aggregate client's constructor becomes internal whenever any interface is internal (a public constructor cannot take an internal type). A request record built from an internal model is internal too. `@access` and `@clientName` also work on a generic model (`@access(Access.internal) model Page<T>`).

#### `internal-access-leak` lint rule

A public operation or model that references an `@access(Access.internal)` type produces C# that cannot compile (`CS0053`, inconsistent accessibility), so the emitter ships a lint rule that warns about it. Enable it by adding the library's ruleset to `tspconfig.yaml`:

```yaml
linter:
  extends:
    - "@massivescale/tsp-refit-client/recommended"
```

It follows the types the emitter actually writes: parameters, request bodies (including the model a merge-patch body patches), the success responses a method returns, model properties, template arguments (`Page<Secret>`), and a public `@discriminator` subtype of an internal base type (`CS0060`). It also checks operations declared directly in a namespace. The fix is either to mark the referenced type `@access(Access.public)` or to mark the interface (or, for a property, its model) `@access(Access.internal)` as well. Marking an _operation_ internal does not help: C# interface methods cannot carry an access modifier, so the rule still reports it.

## Using the generated client

After running `tsp compile`, the emitter writes a self-contained C# project to your configured output directory:

```
<output-dir>/
  Endpoints/
    ICustomers.g.cs          # Refit interface per TypeSpec interface
  Models/
    Customer.g.cs            # C# records and enums for every model
    CustomerCreateRequest.g.cs
    MergePatch.g.cs          # Only when a merge-patch body is used
  Infrastructure/
    ClientRuntime.g.cs       # Refit settings, message handler, wire formats (internal)
  ApiClientExtensions.g.cs   # Aggregate client + DI registration helper
  ApiClient.csproj           # Project file (Refit + Refit.HttpClientFactory)
```

### 1. Reference the generated project

Add a project reference from your application to the generated `.csproj`:

```xml
<!-- YourApp.csproj -->
<ItemGroup>
  <ProjectReference Include="../path/to/client/ApiClient.csproj" />
</ItemGroup>
```

### 2. Register with dependency injection

Call the generated extension method in your `Program.cs`:

```csharp
builder.Services.AddApiClient(client =>
{
    client.BaseAddress = new Uri("https://api.example.com");
});
```

To add delegating handlers (e.g. auth, logging) or resilience policies, pass the optional second argument:

```csharp
builder.Services.AddApiClient(
    client => client.BaseAddress = new Uri("https://api.example.com"),
    builder => builder
        .AddHttpMessageHandler<AuthHeaderHandler>()
        .AddStandardResilienceHandler()
);
```

Without dependency injection, create the client directly. A client from `Create` owns the `HttpClient` it builds, so dispose it when you are done (create one and reuse it, as with any `HttpClient`):

```csharp
using var api = ApiClient.Create(new Uri("https://api.example.com"));

// or with your own handler pipeline underneath, which the client then owns too
using var api = ApiClient.Create(new Uri("https://api.example.com"), myHandler);
```

`Create` returns an `ApiClient.Standalone`, an `ApiClient` that is `IDisposable`. The `ApiClient` the container builds is not disposable: its handlers belong to `IHttpClientFactory`.

> **Always create the interfaces through `Add{Client}` or `Create`.** The interfaces only send and read values in their wire format with the Refit settings from `ApiClient.CreateRefitSettings()` and the message handler from `ApiClient.CreateHttpMessageHandler()`. If you build an interface yourself with `RestService.For<IItems>(...)`, pass both: `RestService.For<IItems>(new HttpClient(ApiClient.CreateHttpMessageHandler(new HttpClientHandler())) { BaseAddress = ... }, ApiClient.CreateRefitSettings())`. With Refit's defaults, enums, durations, `@encode`, text and bytes bodies, headers and cookies would not travel as the API expects.

### 3. Inject and call

Inject the single aggregate client and access each endpoint group as a named property:

```csharp
public class ProductService(ApiClient api)
{
    public Task<Item> GetAsync(string id, CancellationToken ct) =>
        api.Items.ReadAsync(id, cancellationToken: ct);

    public Task<Item> CreateAsync(ItemCreateRequest body, CancellationToken ct) =>
        api.Items.CreateAsync(body, cancellationToken: ct);
}
```

You can also inject an interface directly (`IItems`), which is the easiest thing to substitute in tests.

Optional TypeSpec parameters (`?`) are emitted as nullable C# types with `= null` defaults so callers can omit them:

```csharp
// TypeSpec: list(@query skip?: int32, @query take?: int32): Item[];
Task<List<Item>> ListAsync(int? skip = null, int? take = null, Dictionary<string, object>? additionalQueryParameters = null, CancellationToken cancellationToken = default);

// Call site:
await api.Items.ListAsync(skip: 20, take: 10, cancellationToken: ct);
```

### Errors

A non-success response throws Refit's `ApiException`, carrying the status code and body:

```csharp
try
{
    await api.Items.ReadAsync(id);
}
catch (ApiException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
{
    var problem = await ex.GetContentAsAsync<ApiError>();
}
```

Models that only an error response uses (an `@error` model such as `ApiError`) are generated too, even though no method returns them, so the body of a failed call can be read as a typed model.

### Adding custom query parameters

Every generated method accepts an `additionalQueryParameters` dictionary, so callers can append query parameters that aren't part of the TypeSpec contract (feature flags, tracing params, etc.) to any call. Values are written in their wire format:

```csharp
await api.Items.ListAsync(
    skip: 20,
    additionalQueryParameters: new Dictionary<string, object> { ["debug"] = true },
    cancellationToken: ct);
// GET /api/items?skip=20&debug=true
```

## Requirements

- **.NET 8 or later.**
- Refit and Refit.HttpClientFactory 11.x (referenced by the generated project).

## How requests are sent

The generated interfaces are Refit interfaces. Refit's own defaults would send several TypeSpec values in the wrong format, so the generated `ClientRuntime` supplies three things, which `Add{Client}` and `Create` install:

- a **JSON serializer** for bodies and responses,
- a **URL parameter formatter** for query and path values,
- a **message handler** that writes header and cookie parameters, finishes text and bytes bodies, and applies response encodings.

The rules they follow:

- JSON uses `System.Text.Json` with web defaults (camelCase, case-insensitive reads, numbers accepted as strings). Models carry explicit `[JsonPropertyName]` attributes, so declared properties always use their wire names: the TypeSpec name, or the name given with `@encodedName("application/json", ...)`. A discriminator uses its property's JSON encoded name too. An optional property that is `null` is left out; a required property that allows null (`note: string | null`, or `nothing: null`) is always written, as `"note": null` when it is null.
- Enums are read and written as their declared values through a converter generated for each enum (`ColorJsonConverter`), because `JsonStringEnumConverter` ignores `[EnumMember]` and would write the C# member name. A member declared with a number (`enum Status { ready: 1 }`) travels as a JSON number, and an enum can mix both. A value the enum does not declare, or a token of the wrong kind, is rejected with a `JsonException`, and an undeclared value such as `(Color)99` in a query, path, header or cookie is rejected with an `ArgumentException` instead of being sent as its number.
- Query, path, header and cookie values use enum wire names, lower-case booleans (`true`/`false`), ISO 8601 dates and durations (`2024-01-02T03:04:05.0000000+00:00`, `PT1H30M`), base64 bytes, and the invariant culture for numbers. A date-time header is an RFC 7231 date (`Tue, 02 Jan 2024 03:04:05 GMT`) unless it is given another `@encode`, as TypeSpec specifies.
- Path values are fully percent-encoded, so a value containing `/` or `?` cannot change the shape of the URL; a string path parameter with `@path(#{ allowReserved: true })` keeps its `/` (Refit's `{**name}` placeholder). A path parameter whose wire name differs from its C# name is bound with `[AliasAs]`.
- A `@query` array that is not exploded (TypeSpec's default) is sent as one comma-separated value, `tags=a,b`. With `@query(#{ explode: true })` it is repeated, `tags=a&tags=b`.
- Header parameters are sent as headers and `@cookie` parameters as one `Cookie` header, both written by the message handler. A `Content-Type` header declared as an operation parameter is not exposed; the body's media type decides it.
- Unions map to what is on the wire, since C# has no union type: `T | null` is `T?`; a union whose variants are all strings (literals, `string`, string enums) is `string`; any other union, such as models, or a string and a number, is `System.Text.Json.JsonElement`, which holds whatever the server sends (read it with `Deserialize<T>()`). A literal type maps to its underlying type (`"dog"` is `string`, `5` is `int`). An `integer` is a `long`.
- `@format("uuid")` on a string, whether on a property, a parameter, or a scalar, maps to `Guid`, and `@format("uri")` or `@format("url")` maps to `Uri`.
- A JSON body is sent as `application/json` when the operation accepts it, and otherwise with the JSON media type it declares (`application/vnd.acme+json`, `application/merge-patch+json`), through the same serializer.
- A `bytes` body or response with a non-JSON media type is sent and read raw.
- A scalar body or response (`string`, `int32`, `boolean`, `utcDateTime`, `duration`, `decimal`, ...) is `text/plain` in TypeSpec unless declared otherwise, so it is sent as its wire text (`42`, `true`, `PT1H`) and read back by parsing that text. Text is encoded with the charset its media type declares (including Windows and IBM code pages such as `windows-1252`), and UTF-8 otherwise. A union of scalars read as text is a `JsonElement` holding the number, boolean, or string that arrived.
- A response declared as both JSON and text is read according to the `Content-Type` the server actually sends. A JSON string response is returned as the string, without its quotes.
- When an operation has a success response without a body (`Widget | void`), the method returns a nullable type, which is `null` when the server answers with that bodyless status. A `string` result is the exception: Refit returns the content of a string response itself, so a bodyless status gives `""`.
- An optional body (`@body body?: Widget`) is an optional parameter; when it is left out, the request is sent with no body at all rather than a JSON `null`.
- When an operation's success responses carry different bodies (a 200 `Item` and a 201 `CreatedItem`), the method returns a `JsonElement` holding whichever arrived; when they all carry the same body, the method returns that type.
- A request body is filtered by visibility at every depth: a property hidden from the request (a read-only `id`) is left out of a request record (`WidgetCreateRequest`), and so is one of a nested model, a list or dictionary item, or any model of a `@discriminator` hierarchy, whose request records mirror the hierarchy so any subtype can be sent with its discriminator. Request records are shared between operations only when their visible properties match; otherwise each operation gets its own (`WidgetCreateDraftRequest`).
- Versioning is applied to everything that is emitted: an operation, a parameter, a model property, an enum member, a `@discriminator` subtype, and a whole model or enum is left out of any version that does not have it.
- Names that become C# string literals (property, query and header names, discriminator and enum values, media types, routes) are escaped.

### Polymorphism (`@discriminator`)

A model decorated with the standard TypeSpec `@discriminator("propName")` decorator is emitted with `[JsonPolymorphic]` / `[JsonDerivedType]` attributes, and its derived models are emitted as C# records that inherit from it, so `System.Text.Json` can deserialize a base-typed response into the correct concrete type at runtime:

```typespec
@discriminator("kind")
model Pet { kind: string; name: string; }

model Dog extends Pet { kind: "dog"; isBarker: boolean; }
model Cat extends Pet { kind: "cat"; isPurrer: boolean; }
```

```csharp
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(Cat), "cat")]
[JsonDerivedType(typeof(Dog), "dog")]
public abstract record Pet { ... }

public record Dog : Pet { public bool IsBarker { get; init; } }
public record Cat : Pet { public bool IsPurrer { get; init; } }

// A response typed as List<Pet> deserializes each element to its concrete Dog/Cat type.
List<Pet> pets = await api.Pets.ListAsync();
```

`Dog` and `Cat` are emitted even though nothing in the TypeSpec definition references them directly; they only ever appear as a polymorphic `Pet` at runtime.

A subtype is sent with its discriminator wherever it is declared, as a body (`@body body: Dog`) or as a property, not only through `Pet`.

`Pet` is emitted as `abstract` because a bare `Pet` has no valid JSON shape of its own: `System.Text.Json` would throw at the first (de)serialization attempt. This also applies to pass-through grouping models with no discriminator value of their own. Set `"abstract-discriminated-base": false` to keep these records concrete instead.

### Encodings (`@encode`)

`@encode` changes how a value is written on the wire. The client implements every encoding TypeSpec defines, for model properties (with a `[JsonConverter]`), query, path, header and cookie parameters, and plain-text bodies and responses. An encoding it cannot honour is an error (`unsupported-encoding`), and an operation that sends or reads such a value is left out, because the value would otherwise travel in a format the API does not expect.

| Encoding                                                                                                      | On the wire                                                                                            |
|---------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| none, or `rfc3339` / `ISO8601` / `base64`                                                                     | The default: RFC 3339 dates, ISO 8601 durations (`PT1H30M`), base64 bytes, JSON numbers.               |
| `@encode("string")` on a `boolean`                                                                            | The property or parameter is a C# `string` (`"true"` / `"false"`).                                     |
| `@encode("string")` on a number (`int64`, `float64`, `decimal`, ...)                                          | The C# type stays numeric and is written and read as a JSON string, so an `int64` keeps its precision. |
| `unixTimestamp` on a date-time                                                                                | Whole seconds since 1970 (`1704164645`).                                                               |
| `rfc7231` on a date-time                                                                                      | An HTTP date (`Tue, 02 Jan 2024 03:04:05 GMT`). The default for a date-time header.                    |
| `seconds` / `milliseconds` on a duration                                                                      | A number, whole or with a fraction following the type it is encoded as (`90`, `1.5`).                  |
| `base64url` on bytes                                                                                          | URL-safe base64 without padding (`-_8`).                                                               |
| `ArrayEncoding.pipeDelimited` / `spaceDelimited` / `commaDelimited` / `newlineDelimited` on a list of scalars | One string (`a\|b`), in a JSON property or a parameter.                                                |

Not supported, and reported as an error: a custom encoding name, `@encode("string")` on a date or duration, a delimited list of models, a delimited list as a whole plain-text body, a newline-delimited list in a header or cookie (a header value cannot contain a line break), and a special encoding on a JSON body that is a single scalar (a standalone body has no property to carry the converter).

### What is not supported

A request or success response that cannot be sent or read correctly is reported as an error (`unsupported-feature`) and that one operation is left out of the client, rather than being generated with the wrong behaviour. The rest of the client is generated. Call such an operation through a Refit interface or `HttpClient` of your own.

- Multipart request or response bodies (`@multipartBody`).
- File bodies (`Http.File`).
- A template model carrying `@discriminator` (`@discriminator("kind") model Shape<T>`). System.Text.Json cannot list the subtypes of a generic base. Reported as `unsupported-generic-discriminator`; declare the discriminated base as a non-template model.
- A template model given a value for a template parameter (`model Sized<N extends valueof int32>`, used as `Sized<3>`). A C# generic type takes types, not values. Reported as `unsupported-value-template`.
- A model, list, or dictionary declared only with a non-JSON media type (`application/xml`, `application/x-www-form-urlencoded`, `application/x-ndjson`, ...). A scalar with a non-JSON media type is sent as text, as above.
- A response that may arrive in a media type the client cannot read as its type, such as a model declared as `application/json` or `application/xml`.
- Success responses with different bodies that are not all JSON (a 200 model and a 201 plain-text string), and success responses that carry the same value in different `@encode` formats.
- A `@discriminator` model that is also a variant of another discriminated model (a nested discriminator). `System.Text.Json` can resolve only one discriminator per hierarchy. Reported as `unsupported-nested-discriminator`. A grouping model with no discriminator of its own (`model Dog extends Animal {}`) is fine.
- `@encode` values the client cannot honour (see the encodings table). Reported as `unsupported-encoding`.
- Streaming responses such as server-sent events are read in full before the call returns.
- A `@list` operation whose paging metadata doesn't resolve to a supported forward-iteration strategy — a paging role nested inside a sub-object instead of declared directly, an optional `@pageItems` array, a `continuationToken` output with no matching input parameter or that is not a string, an anonymous/unmappable page response type, a wrapper name another operation's method already uses, or no `nextLink`/`continuationToken`/`offset`/`pageIndex` signal at all. Reported as `unsupported-paging-style`; the raw single-page method is still generated.

### Merge-patch request bodies

A PATCH operation whose body is `MergePatchUpdate<T>` (or `MergePatchUpdateReplaceOnly<T>` / `MergePatchCreateOrUpdate<T>`) maps to an `IMergePatch<T>` parameter, sent as `application/merge-patch+json`:

```typespec
@route("/widgets")
interface Widgets {
  @patch update(@path id: string, @body body: MergePatchUpdate<Widget>): Widget;
}
```

```csharp
[Patch("/api/widgets/{id}")]
[Headers("Content-Type: application/merge-patch+json")]
Task<Widget> UpdateAsync(string id, [Body(BodySerializationMethod.Serialized, true)] IMergePatch<Widget> body, ...);
```

`MergePatch<T>` (which implements `IMergePatch<T>`) is a helper class the emitter writes to `Models/MergePatch.g.cs`, in the same namespace as the records. It is only emitted when something actually uses a merge-patch body. (If your TypeSpec declares several `@service` namespaces, each one that needs the helper gets its own copy; the extra files are named after their namespace.)

The point of a merge patch (RFC 7396) is that it carries only the fields you want changed. The helper is a builder for exactly that:

```csharp
var patch = new MergePatch<Widget>()
    .Set(w => w.Name, "new name")  // send a new value
    .Clear(w => w.Description);    // send an explicit null, clearing the field

await client.Widgets.UpdateAsync(id, patch, cancellationToken: ct);
// body: {"name":"new name","description":null}
```

| Method                 | Effect on the request body                                              |
|------------------------|-------------------------------------------------------------------------|
| `Set(selector, value)` | Sends the property with that value.                                     |
| `Clear(selector)`      | Sends the property as JSON `null`, asking the server to clear it.       |
| `Remove(selector)`     | Drops the property from the body, so the request says nothing about it. |
| `IsDefined(selector)`  | Whether the body carries the property (including an explicit `null`).   |
| `IsNull(selector)`     | Whether the body carries the property as `null`.                        |

Every method also takes a plain JSON wire name (`patch.Set("displayName", "…")`) if you need a property that isn't on the model. With the expression form, the wire name is read from the record's `[JsonPropertyName]` attribute. A value is written with the client's serializer settings and its own runtime type, so it travels in its property's format.

The expression form only accepts a property read straight off the lambda parameter, because a merge patch is a flat map of the model's own JSON properties. Something nested like `w => w.Name.Length` throws `ArgumentException` rather than quietly sending a `"Length"` field the server has never heard of. To patch inside a nested object, `Set` the whole object.

> **Note:** this is the client-side counterpart to the `MergePatch<T>` emitted by `@massivescale/tsp-aspnetcore-api`. That one is built for _reading_ a patch in a controller; this one is built for _writing_ one. If your solution references both generated projects, the two types live in different namespaces and do not conflict, but don't `using` both into the same file.

### Pagination

An operation decorated `@list`, whose response declares `@pageItems`, gets a second generated method alongside the raw single-page one: an `IAsyncEnumerable<T>` extension method that transparently follows every page. Detection uses TypeSpec's own core pagination decorators — `@list`, `@pageItems`, `@nextLink`, `@continuationToken`, `@offset`, `@pageIndex` — never an assumed field-naming convention, so it works with any API that follows the TypeSpec paging model.

```typespec
model PagedResult<T> {
  @pageItems items: T[];
  @nextLink next?: url;
}

@route("/stores")
interface Stores {
  @list @get list(skip?: int32, take?: int32): PagedResult<Store>;
}
```

```csharp
await foreach (var store in client.Stores.ListAllAsync(httpClientFactory, cancellationToken: ct))
{
    // one Store per iteration, across every page
}
```

| Strategy                 | How the wrapper advances                                                                                                                       | Extra parameter      |
|--------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|----------------------|
| `@nextLink`              | Follows the response's next-page link through the interface's own named `HttpClient`, bypassing Refit for continuation requests.               | `IHttpClientFactory` |
| `@continuationToken`     | Re-calls the raw Refit method, feeding the previous response's token back into the matching input parameter. The token must be a `string`.     | none                 |
| `@offset` / `@pageIndex` | Re-calls the raw Refit method with the counter advanced by the received item count (`offset`) or by one (`pageIndex`); stops on an empty page. | none                 |

When more than one signal is present on a page model, `nextLink` wins over `continuationToken`, which wins over `offset`/`pageIndex` — `nextLink` is the most self-contained, since the URL already embeds everything the next request needs. `prevLink`/`firstLink`/`lastLink` are backward/random-access links, not forward-iteration drivers, and render as ordinary model properties with no special codegen.

Only the `nextLink` strategy needs the extra `IHttpClientFactory` parameter. `Add{Client}` registers the interface's `HttpClient` under a name the wrapper resolves, so continuation requests go through the same configuration, handlers, and serializer as the first page. The operation's header and cookie parameters are sent again on every continuation request, in the same wire format; query parameters are expected to be part of the link.

A next-page link comes from the server, and the client sends it with whatever credentials you configured, such as an `Authorization` default header or an authentication handler. So each link is resolved against the client's `BaseAddress` (a relative link is fine) and must keep the same scheme, host, and port: a link to any other origin throws `InvalidOperationException` before the request is sent. A client with no `BaseAddress` throws as soon as the API returns a next-page link.

An operation whose success may carry no body (`PagedResult<Store> | void`) ends the enumeration when that empty success comes back.

## Multiple API versions

By default only the latest declared version is emitted (or the one named by `target-version`), into the root namespace. Set `all-versions: true` to emit every version side by side. An API with no `@versioned` declaration has only one "version" and is emitted normally, with no version folder.

Each version is emitted from TypeSpec's projection of the service onto that version, so every declaration has exactly the shape it has there: not only whether it exists (`@added`, `@removed`), but its name (`@renamedFrom`), its type (`@typeChangedFrom`, `@returnTypeChangedFrom`), and whether it is optional (`@madeOptional`, `@madeRequired`). Diagnostics about a declaration are reported once, however many versions are emitted.

```
<output-dir>/
  v1.0/
    Endpoints/        # IWidgets, ... for v1.0
    Models/           # Widget, Status, WidgetCreateRequest, ... exactly as v1.0 declares them
    ApiClientExtensions.g.cs
  v2.0/
    Endpoints/
    Models/
    ApiClientExtensions.g.cs
  Infrastructure/     # ClientRuntime: shared by every version
  Models/MergePatch.g.cs   # only when used; shared
  ApiClient.csproj
```

Each version is emitted on its own, into the namespace `<root>.V1_0`, `<root>.V2_0`, and so on. A property `@added(Versions.v2)` is absent from `V1_0.Widget`, an enum member `@removed(Versions.v2)` is absent from `V2_0.Status`, a model that only exists from v2 is only generated in `V2_0`, and a `@discriminator` subtype only registers in the versions that have it. Routes use the version (`/api/v1.0/widgets`). Both versions can be registered in one application, since each version's interfaces are distinct types:

```csharp
V1_0.ApiClientExtensions.AddApiClient(services, http => http.BaseAddress = baseAddress);
V2_0.ApiClientExtensions.AddApiClient(services, http => http.BaseAddress = baseAddress);
```

A model in a single-version emit (no `all-versions`) is projected onto that version in the same way, and `version-in-namespace` moves only the endpoints into the version namespace.

## Development

### Prerequisites

- Node.js (LTS)
- npm 11+
- The .NET SDK (8 and 10), to build the generated C# and run the end-to-end tests

### Setup

```powershell
npm install
```

### Build

TypeScript must be compiled before running tests:

```powershell
npm run build
```

Use watch mode during active development:

```powershell
npm run watch
```

### Test

```powershell
npm run build && npm test
```

To run a single test file:

```powershell
node --test dist/test/endpoints.test.js
```

The end-to-end tests compile the examples, then run the **generated C#** against a stubbed HTTP layer, so they prove each value really travels in its wire format and every model and enum round-trips through the client's serializer:

```powershell
cd example/kitchen-sink; npm install; npx tsp compile .
dotnet run --project ../../e2e/Refit.Tests -f net8.0
dotnet run --project ../../e2e/Refit.Tests -f net10.0
```

### Compile matrix

`npm run matrix` generates one spec covering every type shape in every position, every `@encode` in every position, every media type, awkward names, visibility, and discriminators. Whatever TypeSpec itself rejects is pruned; for the rest, the emitter must either report it or generate C# that builds with warnings as errors and whose every model and enum round-trips through the client serializer.

```powershell
npm run build
npm run matrix                    # check
npm run matrix -- --update        # accept a change to the operations left out
```

The operations the emitter leaves out are recorded in `matrix/left-out.txt`, so a supported case that starts being left out fails the run. On a machine whose NuGet config includes a private feed that rejects the current credentials, set `MATRIX_RESTORE_SOURCES=https://api.nuget.org/v3/index.json`.

### Lint & Format

```powershell
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format        # format all files
npm run format:check  # check formatting without writing
```

## Examples

- [`example/simple-api/`](example/simple-api/): a small widget service.
- [`example/kitchen-sink/`](example/kitchen-sink/): most of TypeSpec at once (every scalar, unions, generics, discriminators, encodings, cookies, query styles, error models). It is the main subject of the end-to-end tests.
- [`example/all-versions/`](example/all-versions/): a service whose versions differ in models, enums, subtypes, operations and parameters, emitted with `all-versions`.
- [`example/versioned-api/`](example/versioned-api/): a versioned Pet Store. Run it with `./example/versioned-api/build.ps1`.

## Contributing

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for architecture details, conventions, and development guidance.

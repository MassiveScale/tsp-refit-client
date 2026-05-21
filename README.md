# tsp-refit-client

[TypeSpec](https://typespec.io) emitter for generating C# API clients using [Refit](https://www.nuget.org/packages/Refit).

## Summary

This emitter produces a C# project with Refit-capable interfaces for each `GET`, `POST`, `PATCH`, and `DELETE` operation in your TypeSpec definition. The generated client contains everything needed to call your APIs — simply provide the base URI at runtime.

It is also version-aware, allowing you to call any endpoint version from a single client.

> **Status:** Early development. Core C# code generation is implemented; some edge cases and advanced TypeSpec features may not yet be handled.

## Usage

Add the emitter to your TypeSpec project:

```bash
npm install tsp-refit-client
```

Configure it in your `tspconfig.yaml`:

```yaml
emit:
  - "tsp-refit-client"
options:
  "tsp-refit-client":
    emitter-output-dir: "{output-dir}/client"
```

Then compile your TypeSpec definition:

```bash
tsp compile .
```

## Using the generated client

After running `tsp compile`, the emitter writes a self-contained C# project to your configured output directory:

```
<output-dir>/
  Endpoints/
    ICustomers.cs          # Refit interface per TypeSpec interface
  Models/
    Customer.cs            # C# records for every model
    CustomerCreateRequest.cs
  ApiClientExtensions.cs   # DI registration helper
  ApiClient.csproj         # Project file (Refit + Refit.HttpClientFactory)
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

To add delegating handlers (e.g. auth, logging) or Polly resilience policies, pass the optional second argument:

```csharp
builder.Services.AddApiClient(
    client => client.BaseAddress = new Uri("https://api.example.com"),
    builder => builder
        .AddHttpMessageHandler<AuthHeaderHandler>()
        .AddStandardResilienceHandler()
);
```

### 3. Inject and call

The Refit interfaces are registered as transient services and can be injected directly:

```csharp
public class ProductService(IItems items)
{
    public Task<List<string>> GetAllAsync(CancellationToken ct) =>
        items.ListAsync(ct);
}
```

## Development

### Prerequisites

- Node.js (LTS)
- npm 11+

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
node --test dist/test/emitter.test.js
```

### Lint & Format

```powershell
npm run lint          # check for lint errors
npm run lint:fix      # auto-fix lint errors
npm run format        # format all files
npm run format:check  # check formatting without writing
```

## Example

The [`example/versioned-api/`](example/versioned-api/) directory contains a versioned Pet Store TypeSpec API demonstrating multi-version route and model definitions. Once the emitter is functional, run the example builds via:

```powershell
./example/versioned-api/build.ps1
```

## Contributing

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for architecture details, conventions, and development guidance.

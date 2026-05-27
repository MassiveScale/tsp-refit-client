import { createTypeSpecLibrary, JSONSchemaType, paramMessage } from "@typespec/compiler";
import type { TemplateOverrides } from "./renderer.js";

export interface EmitterOptions {
  "project-name"?: string;
  "client-name"?: string;
  "root-namespace"?: string;
  "net-version"?: string;
  "target-version"?: string;
  "all-versions"?: boolean;
  "version-in-namespace"?: boolean;
  "emit-project-file"?: boolean;
  "overwrite-project-file"?: boolean;
  "dotnet-format"?: boolean;
  "nuget-package-id"?: string;
  "nuget-version"?: string;
  "nuget-authors"?: string;
  "nuget-description"?: string;
  "nuget-title"?: string;
  "nuget-tags"?: string;
  templates?: TemplateOverrides;
}

const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "project-name": {
      type: "string",
      description:
        "Override the full project name used for the .csproj filename. Defaults to the TypeSpec namespace + 'Client' (e.g. namespace 'My.Api' → 'My.ApiClient'). Dots are valid; C# identifiers use only the final segment.",
      nullable: true,
    },
    "client-name": {
      type: "string",
      description:
        "The client display name. Used as the DI extension class/method prefix (e.g. 'PetStore' → 'AddPetStore(...)') and as the default NuGet <Title> when 'nuget-title' is not set.",
      nullable: true,
    },
    "root-namespace": {
      type: "string",
      description: "Override the root C# namespace. Defaults to the TypeSpec namespace + '.Client'.",
      nullable: true,
    },
    "net-version": {
      type: "string",
      description:
        "Target .NET version(s) for the generated project file. Use a single TFM (e.g. 'net8.0') or a semicolon-separated list for multi-targeting (e.g. 'net8.0;net9.0'). Defaults to 'net8.0'.",
      nullable: true,
    },
    "target-version": {
      type: "string",
      description:
        "The specific API version to generate (e.g. 'v2.0'). Defaults to the latest declared version. Ignored when 'all-versions' is true.",
      nullable: true,
    },
    "all-versions": {
      type: "boolean",
      description:
        "When true, generate clients for every declared API version. Defaults to false (latest version only).",
      nullable: true,
    },
    "version-in-namespace": {
      type: "boolean",
      description:
        "When true, appends the sanitized API version to the C# namespace in single-version mode. Ignored when 'all-versions' is true (version is always appended then). Defaults to false.",
      nullable: true,
    },
    "emit-project-file": {
      type: "boolean",
      description: "When false, the .csproj is not emitted at all. Defaults to true.",
      nullable: true,
    },
    "overwrite-project-file": {
      type: "boolean",
      description:
        "When false (default), the .csproj is only written if it does not already exist. Set to true to always overwrite it.",
      nullable: true,
    },
    "dotnet-format": {
      type: "boolean",
      description:
        "When true (default), run 'dotnet format' on the output directory after emitting. Set to false to skip formatting.",
      nullable: true,
    },
    "nuget-package-id": {
      type: "string",
      description: "NuGet <PackageId>. Omitted when not set.",
      nullable: true,
    },
    "nuget-version": {
      type: "string",
      description: "NuGet <Version>. Omitted when not set.",
      nullable: true,
    },
    "nuget-authors": {
      type: "string",
      description: "NuGet <Authors> (comma-separated). Omitted when not set.",
      nullable: true,
    },
    "nuget-description": {
      type: "string",
      description:
        "NuGet <Description>. Defaults to 'Refit client for the {namespace} API'.",
      nullable: true,
    },
    "nuget-title": {
      type: "string",
      description:
        "NuGet <Title>. Defaults to 'client-name' when set; omitted otherwise.",
      nullable: true,
    },
    "nuget-tags": {
      type: "string",
      description: "NuGet <PackageTags> (space-separated). Omitted when not set.",
      nullable: true,
    },
    templates: {
      type: "object",
      description: "Override built-in Handlebars templates with custom .hbs file paths.",
      additionalProperties: false,
      nullable: true,
      properties: {
        file: { type: "string", nullable: true, description: "Outer file wrapper template." },
        record: { type: "string", nullable: true, description: "C# record (model) template." },
        enum: { type: "string", nullable: true, description: "C# enum template." },
        "refit-interface": { type: "string", nullable: true, description: "Refit interface template." },
        csproj: { type: "string", nullable: true, description: ".csproj project file template." },
        extensions: {
          type: "string",
          nullable: true,
          description: "DI registration extension class template.",
        },
      },
      required: [],
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "@massivescale/tsp-refit-client",
  diagnostics: {
    "template-load-failed": {
      severity: "error",
      messages: {
        default: paramMessage`Failed to load Handlebars template: ${"message"}`,
      },
    },
    "version-not-found": {
      severity: "error",
      messages: {
        default: paramMessage`Version "${"version"}" was not found. Available versions: ${"available"}.`,
      },
    },
    "dotnet-format-failed": {
      severity: "warning",
      messages: {
        default: paramMessage`dotnet format failed: ${"message"}`,
      },
    },
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;

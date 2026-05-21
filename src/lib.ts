import { createTypeSpecLibrary, JSONSchemaType, paramMessage } from "@typespec/compiler";
import type { TemplateOverrides } from "./renderer.js";

export interface EmitterOptions {
  "root-namespace"?: string;
  "net-version"?: string;
  "target-version"?: string;
  "all-versions"?: boolean;
  "emit-project-file"?: boolean;
  "overwrite-project-file"?: boolean;
  templates?: TemplateOverrides;
}

const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
  type: "object",
  additionalProperties: false,
  properties: {
    "root-namespace": {
      type: "string",
      description: "Override the root C# namespace. Defaults to the TypeSpec namespace + '.Client'.",
      nullable: true,
    },
    "net-version": {
      type: "string",
      description: "Target .NET version for the generated project file. Defaults to 'net8.0'.",
      nullable: true,
    },
    "target-version": {
      type: "string",
      description: "The specific API version to generate (e.g. 'v2.0'). Defaults to the latest declared version. Ignored when 'all-versions' is true.",
      nullable: true,
    },
    "all-versions": {
      type: "boolean",
      description: "When true, generate clients for every declared API version. Defaults to false (latest version only).",
      nullable: true,
    },
    "emit-project-file": {
      type: "boolean",
      description: "When false, the .csproj is not emitted at all. Defaults to true.",
      nullable: true,
    },
    "overwrite-project-file": {
      type: "boolean",
      description: "When false (default), the .csproj is only written if it does not already exist. Set to true to always overwrite it.",
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
        extensions: { type: "string", nullable: true, description: "DI registration extension class template." },
      },
      required: [],
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: "tsp-refit-client",
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
  },
  emitter: {
    options: EmitterOptionsSchema,
  },
});

export const { reportDiagnostic, createDiagnostic } = $lib;

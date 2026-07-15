// Client wiring generation: the DI registration extension class
// (`Add{Client}(...)`) and the aggregate client class that exposes one
// strongly-typed property per generated Refit interface.

import {
  Renderer,
  ExtensionsView,
  InterfaceEntry,
  FileView,
} from "./renderer.js";
import { sortUsings } from "./utils.js";

/**
 * Renders the DI wiring file for a service: a `{ServiceName}Extensions` static
 * class exposing `Add{ServiceName}(...)`, plus the aggregate client class that
 * surfaces one strongly-typed property per generated Refit interface.
 *
 * @param serviceName - Client/service display name (e.g. `PetStore`); drives the
 *   extension class name, the `Add…` method name, and the aggregate client name.
 * @param csNs - C# namespace the generated file is emitted into.
 * @param interfaceNames - Refit interface names to register (e.g. `IPets`), each
 *   mapped to a client property/parameter with the leading `I` stripped.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @returns The full C# source of the generated extensions file.
 */
export function buildExtensions(
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

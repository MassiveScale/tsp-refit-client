// Client wiring generation: the aggregate client class that exposes one
// strongly-typed property per generated endpoint interface, and the DI
// registration extension class (`Add{Client}(...)`).

import {
  Renderer,
  ExtensionsView,
  InterfaceEntry,
  FileView,
} from "./renderer.js";
import { escapeCsIdentifier, sortUsings } from "./utils.js";

/** A Refit interface, as wired into the aggregate client. */
export interface EndpointName {
  /** C# interface name, e.g. `IPets`. */
  interfaceName: string;
  /** C# access modifier of the interface: `"public"` or `"internal"`. */
  access: string;
  /**
   * Set (already namespace-qualified, e.g. `"My.Api.Client.IStores"`) only
   * when this interface has at least one `nextLink`-strategy paging wrapper,
   * which needs a named `HttpClient`/`RefitSettings` registration under that
   * exact name. Interfaces using only the `continuationToken`/`offset`/
   * `pageIndex` strategies, or no paging at all, leave this unset.
   */
  pagingHttpClientName?: string;
}

/**
 * Renders the wiring file for a service: a `{ServiceName}` aggregate client class
 * that surfaces one strongly-typed property per generated endpoint interface, and
 * a `{ServiceName}Extensions` static class exposing `Add{ServiceName}(...)`.
 *
 * @param serviceName - Client/service display name (e.g. `PetStore`); drives the
 *   aggregate client name, the extension class name, and the `Add…` method name.
 * @param csNs - C# namespace the generated file is emitted into.
 * @param endpoints - The Refit interfaces to register, and their access; each interface maps to a client property/parameter with the leading
 *   `I` stripped. An internal interface becomes an internal property, and any internal
 *   interface makes the aggregate client's constructor internal. `pagingHttpClientName`
 *   marks an interface that needs a named `HttpClient`/`RefitSettings` registration for
 *   its `nextLink`-strategy paging wrapper(s), registered under that exact name.
 * @param renderer - Handlebars renderer used to produce the file contents.
 * @param runtimeNamespace - The C# namespace of the `ClientRuntime` helper, which
 *   the aggregate client names in full so an endpoint property cannot hide it.
 * @param additionalUsings - Extra `using` directives from the `additional-usings`
 *   option, which apply to every emitted file.
 * @returns The full C# source of the generated extensions file.
 */
export function buildExtensions(
  serviceName: string,
  csNs: string,
  endpoints: EndpointName[],
  renderer: Renderer,
  runtimeNamespace: string,
  additionalUsings: Iterable<string> = [],
): string {
  const className = `${serviceName}Extensions`;
  const methodName = `Add${serviceName}`;
  const clientClassName = serviceName;
  // Each endpoint is a constructor parameter. Two endpoint names that differ only in
  // the case of their first letter would declare the same parameter twice (CS0100).
  const takenParams = new Set<string>();
  const interfaces: InterfaceEntry[] = endpoints.map(
    ({ interfaceName, access, pagingHttpClientName }) => {
      const propertyName = interfaceName.startsWith("I")
        ? interfaceName.slice(1)
        : interfaceName;
      const base = propertyName.charAt(0).toLowerCase() + propertyName.slice(1);
      let unescaped = base;
      for (let n = 1; takenParams.has(unescaped); n++) {
        unescaped = n === 1 ? `${base}Endpoint` : `${base}Endpoint${n}`;
      }
      takenParams.add(unescaped);
      return {
        name: interfaceName,
        propertyName,
        paramName: escapeCsIdentifier(unescaped),
        docParamName: unescaped,
        access,
        pagingHttpClientName,
      };
    },
  );
  const view: ExtensionsView = {
    className,
    methodName,
    clientClassName,
    // A public constructor cannot take an internal parameter type (CS0051).
    constructorAccess: endpoints.some((i) => i.access !== "public")
      ? "internal"
      : "public",
    runtimeNamespace,
    interfaces,
  };
  const body = renderer.renderExtensions(view);
  const needsPagingJsonOptions = interfaces.some((i) => i.pagingHttpClientName);
  const fileView: FileView = {
    namespace: csNs,
    usings: sortUsings([
      ...new Set([
        "Microsoft.Extensions.DependencyInjection",
        "Refit",
        "System",
        "System.Net.Http",
        ...(needsPagingJsonOptions ? ["System.Text.Json"] : []),
        ...additionalUsings,
      ]),
    ]),
    body,
    fileName: `${className}.g.cs`,
  };
  return renderer.renderFile(fileView);
}

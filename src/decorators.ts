import type {
  DecoratorContext,
  EnumMember,
  Program,
  Type,
} from "@typespec/compiler";

export const namespace = "MassiveScale.TspRefitClient";

const clientNameKey = Symbol.for("@massivescale/tsp-refit-client/clientName");
const accessKey = Symbol.for("@massivescale/tsp-refit-client/access");

export function $clientName(
  context: DecoratorContext,
  target: Type,
  name: string,
): void {
  context.program.stateMap(clientNameKey).set(target, name);
}

export function $access(
  context: DecoratorContext,
  target: Type,
  value: EnumMember,
): void {
  const v = typeof value.value === "string" ? value.value : value.name;
  context.program.stateMap(accessKey).set(target, v);
}

export function getClientName(
  program: Program,
  type: Type,
): string | undefined {
  return program.stateMap(clientNameKey).get(type) as string | undefined;
}

export function getAccess(
  program: Program,
  type: Type,
): "public" | "internal" | undefined {
  return program.stateMap(accessKey).get(type) as
    | "public"
    | "internal"
    | undefined;
}

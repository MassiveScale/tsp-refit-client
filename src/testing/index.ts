import { resolvePath } from "@typespec/compiler";
import {
  createTestLibrary,
  TypeSpecTestLibrary,
} from "@typespec/compiler/testing";
import { fileURLToPath } from "url";

export const TspRefitClientTestLibrary: TypeSpecTestLibrary = createTestLibrary(
  {
    name: "@massivescale/tsp-refit-client",
    packageRoot: resolvePath(fileURLToPath(import.meta.url), "../../../../"),
  },
);

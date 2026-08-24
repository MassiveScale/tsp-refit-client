import { describe, it, before } from "node:test";
import {
  createLinterRuleTester,
  type LinterRuleTester,
} from "@typespec/compiler/testing";
import { BaseTester } from "./host.js";
import { internalAccessLeakRule } from "../src/rules/internal-access-leak.js";

describe("internal-access-leak", () => {
  let tester: LinterRuleTester;

  before(async () => {
    const runner = await BaseTester.createInstance();
    tester = createLinterRuleTester(
      runner,
      internalAccessLeakRule,
      "@massivescale/tsp-refit-client",
    );
  });

  it("flags a public interface operation whose parameter type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(secret: Secret): void;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("flags a public interface operation whose return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): Secret;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("flags a public interface operation whose array-wrapped return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          list(): Secret[];
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("flags a public interface operation whose union-wrapped return type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        model Widget {
          id: string;
        }

        @access(Access.internal)
        model Secret {
          value: string;
        }

        interface Widgets {
          read(): Widget | Secret;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("flags a public model whose property type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        model Widget {
          secret: Secret;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("flags a public model whose inherited property type is @access(Access.internal)", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        model Base {
          secret: Secret;
        }

        model Widget extends Base {
          id: string;
        }
      `,
      )
      .toEmitDiagnostics({
        code: "@massivescale/tsp-refit-client/internal-access-leak",
      });
  });

  it("is valid when everything is consistently public", async () => {
    await tester
      .expect(
        `
        namespace TestApi;

        model Secret {
          value: string;
        }

        model Widget {
          secret: Secret;
        }

        interface Widgets {
          read(): Widget;
        }
      `,
      )
      .toBeValid();
  });

  it("is valid when everything is consistently internal end-to-end", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        model Widget {
          secret: Secret;
        }

        @access(Access.internal)
        interface Widgets {
          read(): Widget;
        }
      `,
      )
      .toBeValid();
  });

  it("is valid when a public interface's own container access is internal, regardless of referenced types", async () => {
    await tester
      .expect(
        `
        import "@massivescale/tsp-refit-client";
        using MassiveScale.TspRefitClient;

        namespace TestApi;

        @access(Access.internal)
        model Secret {
          value: string;
        }

        @access(Access.internal)
        interface Widgets {
          read(): Secret;
        }
      `,
      )
      .toBeValid();
  });
});

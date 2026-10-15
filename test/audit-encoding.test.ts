import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { emitWithDiagnostics } from "./host.js";

/**
 * An exhaustive check of `@encode`: every encoding TypeSpec defines, in every
 * position a value can travel. Each combination must either be generated with the
 * runtime format applied, or be reported as `unsupported-encoding` with the
 * operation left out. A combination that is generated without its format would
 * send or read a value the API does not expect, which is the failure this guards.
 *
 * The expected outcome comes from one table of what each position can carry, not
 * from per-case expectations, so a new encoding or position is checked the same way.
 */

const PREAMBLE = `
  import "@typespec/http";
  using Http;

  @service(#{ title: "Audit" })
  namespace Audit;
`;

/** How the client handles an encoding: by default, through the runtime, or not at all. */
type Kind =
  "default" | "number-as-string" | "wire" | "delimited" | "unsupported";

/** An encoding: its decorator, the type it applies to, how it is handled, and its runtime format. */
interface Encoding {
  name: string;
  decorator: string;
  type: string;
  kind: Kind;
  wire?: string;
}

const ENCODINGS: Encoding[] = [
  {
    name: "rfc3339",
    decorator: "@encode(DateTimeKnownEncoding.rfc3339)",
    type: "utcDateTime",
    kind: "default",
  },
  {
    name: "rfc7231",
    decorator: "@encode(DateTimeKnownEncoding.rfc7231)",
    type: "utcDateTime",
    kind: "wire",
    wire: "Rfc7231",
  },
  {
    name: "unixTimestamp",
    decorator: "@encode(DateTimeKnownEncoding.unixTimestamp, int64)",
    type: "utcDateTime",
    kind: "wire",
    wire: "UnixSeconds",
  },
  {
    name: "rfc7231 on an offset date-time",
    decorator: "@encode(DateTimeKnownEncoding.rfc7231)",
    type: "offsetDateTime",
    kind: "wire",
    wire: "Rfc7231",
  },
  {
    name: "ISO8601",
    decorator: "@encode(DurationKnownEncoding.ISO8601)",
    type: "duration",
    kind: "default",
  },
  {
    name: "whole seconds",
    decorator: "@encode(DurationKnownEncoding.seconds, int32)",
    type: "duration",
    kind: "wire",
    wire: "WholeSeconds",
  },
  {
    name: "fractional seconds",
    decorator: "@encode(DurationKnownEncoding.seconds, float64)",
    type: "duration",
    kind: "wire",
    wire: "Seconds",
  },
  {
    name: "whole milliseconds",
    decorator: "@encode(DurationKnownEncoding.milliseconds, int64)",
    type: "duration",
    kind: "wire",
    wire: "WholeMilliseconds",
  },
  {
    name: "fractional milliseconds",
    decorator: "@encode(DurationKnownEncoding.milliseconds, float32)",
    type: "duration",
    kind: "wire",
    wire: "Milliseconds",
  },
  {
    name: "base64",
    decorator: "@encode(BytesKnownEncoding.base64)",
    type: "bytes",
    kind: "default",
  },
  {
    name: "base64url",
    decorator: "@encode(BytesKnownEncoding.base64url)",
    type: "bytes",
    kind: "wire",
    wire: "Base64Url",
  },
  {
    name: "a number as a string",
    decorator: `@encode("string")`,
    type: "int64",
    kind: "number-as-string",
  },
  {
    name: "a boolean as a string",
    decorator: `@encode("string")`,
    type: "boolean",
    kind: "default",
  },
  {
    name: "a pipe-delimited list",
    decorator: "@encode(ArrayEncoding.pipeDelimited)",
    type: "string[]",
    kind: "delimited",
    wire: "PipeDelimited",
  },
  {
    name: "a space-delimited list",
    decorator: "@encode(ArrayEncoding.spaceDelimited)",
    type: "int32[]",
    kind: "delimited",
    wire: "SpaceDelimited",
  },
  {
    name: "a comma-delimited list",
    decorator: "@encode(ArrayEncoding.commaDelimited)",
    type: "string[]",
    kind: "delimited",
    wire: "CommaDelimited",
  },
  {
    name: "a newline-delimited list",
    decorator: "@encode(ArrayEncoding.newlineDelimited)",
    type: "string[]",
    kind: "delimited",
    wire: "NewlineDelimited",
  },
  {
    name: "a custom encoding",
    decorator: `@encode("custom")`,
    type: "string",
    kind: "unsupported",
  },
];

/** How a body travels: as JSON, as raw bytes, or as plain text. */
type Transport = "json" | "bytes" | "text";

/**
 * A position a value can travel in: how to declare it, the C# it must produce for
 * a runtime format, and which kinds it can carry. A kind outside `carries` must be
 * reported and its operation left out.
 */
interface Position {
  name: string;
  spec: (e: Encoding) => string;
  /** The generated file that shows the format was applied. */
  file: string;
  /** What that file contains when the runtime format is applied. */
  applied: (e: Encoding) => string;
  carries: Kind[];
  /**
   * For a whole-body position: the body is the value itself, so a list is a JSON
   * array, which cannot carry a delimited format.
   */
  wholeBody?: boolean;
  /** For a whole-body position: how the generated method must send or read the body. */
  transport?: { of: (file: string) => Transport; expected: Transport };
  /** Encodings this position cannot carry even though their kind is in `carries`. */
  cannotCarry?: (e: Encoding) => boolean;
}

/** A header (or cookie) value cannot contain a line break. */
const noLineBreaks = (e: Encoding): boolean => e.wire === "NewlineDelimited";

/** The start of the `[JsonConverter]` attribute a property with the encoding carries. */
const converter = (e: Encoding): string =>
  e.kind === "delimited"
    ? `ClientRuntime.${e.wire}Converter<`
    : `ClientRuntime.${e.wire}Converter))]`;

/** The attribute that tells the runtime which wire format a parameter or text body is written in. */
const encoded = (e: Encoding): string =>
  `[ClientRuntime.Encoded(ClientRuntime.WireEncoding.${e.wire})]`;

/** The Refit collection format of a query list with a delimited `@encode`. */
const COLLECTION_FORMATS: Record<string, string> = {
  PipeDelimited: "Pipes",
  SpaceDelimited: "Ssv",
  CommaDelimited: "Csv",
};

/**
 * What a query parameter with the encoding is declared with: Refit joins a list
 * itself in its collection format, while the runtime's message handler writes a
 * newline-delimited list, which Refit has no collection format for.
 *
 * @param e - The encoding.
 * @returns The attributes the parameter must carry.
 */
function queryApplied(e: Encoding): string {
  if (e.wire === "NewlineDelimited") {
    return `[Property(ClientRuntime.QueryPrefix + "v")] ${encoded(e)}`;
  }
  return e.kind === "delimited"
    ? `[Query(CollectionFormat.${COLLECTION_FORMATS[e.wire!]})]`
    : encoded(e);
}

/**
 * Whether a media type is one JSON document, as the runtime decides it.
 *
 * @param mediaType - The media type, lower-case and without parameters.
 * @returns `true` for `application/json`, `text/json`, or a `+json` type.
 */
function isJsonMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    mediaType === "text/json" ||
    mediaType.endsWith("+json")
  );
}

/**
 * How the runtime's `WireContent` writes the request body of the file's single
 * method: JSON for a JSON (or undeclared) `Content-Type`, the raw bytes of a byte
 * array with no `[ClientRuntime.Encoded]` under a non-text media type, and plain
 * text otherwise.
 *
 * @param file - The generated Refit interface.
 * @returns How the body travels.
 */
function requestTransport(file: string): Transport {
  const mediaType = (
    /\[Headers\("Content-Type: ([^"]+)"\)\]/.exec(file)?.[1] ??
    "application/json"
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (isJsonMediaType(mediaType)) return "json";
  const body =
    /\[Body\([^)]*\)\] (\[ClientRuntime\.Encoded\([^\]]*\)\] )?(\S+) body\b/.exec(
      file,
    );
  if (
    body &&
    !body[1] &&
    body[2].replace(/\?$/, "") === "byte[]" &&
    !mediaType.startsWith("text/")
  ) {
    return "bytes";
  }
  return "text";
}

/**
 * How the runtime's `WireContentSerializer` reads the response of the file's single
 * method when it arrives with its declared non-JSON media type: a byte array with
 * no `[return: ClientRuntime.Encoded]` is handed over raw, and any other scalar is
 * read from its text.
 *
 * @param file - The generated Refit interface.
 * @returns How the body travels.
 */
function responseTransport(file: string): Transport {
  return /Task<byte\[\]\??> \w+Async\(/.test(file) &&
    !/\[return: ClientRuntime\.Encoded\(/.test(file)
    ? "bytes"
    : "text";
}

const POSITIONS: Position[] = [
  {
    name: "a model property",
    spec: (e) =>
      `model M { ${e.decorator} v: ${e.type}; } @route("/x") interface X { @get read(): M; }`,
    file: "Models/M.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "an optional model property",
    spec: (e) =>
      `model M { ${e.decorator} v?: ${e.type}; } @route("/x") interface X { @get read(): M; }`,
    file: "Models/M.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a nullable model property",
    spec: (e) =>
      `model M { ${e.decorator} v: ${e.type} | null; } @route("/x") interface X { @get read(): M; }`,
    file: "Models/M.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a property of a request record",
    spec: (e) =>
      `model M { @visibility(Lifecycle.Read) id: string; ${e.decorator} v: ${e.type}; } @route("/x") interface X { @post create(@body body: M): void; }`,
    file: "Models/MCreateRequest.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a property of a discriminated subtype",
    spec: (e) =>
      `@discriminator("kind") model Base { kind: string; } model M extends Base { kind: "m"; ${e.decorator} v: ${e.type}; } @route("/x") interface X { @get read(): Base; }`,
    file: "Models/M.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a merge-patch body",
    spec: (e) =>
      `model M { ${e.decorator} v?: ${e.type}; } @route("/x") interface X { @patch update(@body body: MergePatchUpdate<M>): void; }`,
    file: "Models/M.g.cs",
    applied: converter,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a query parameter",
    spec: (e) =>
      `@route("/x") interface X { @get read(@query ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: queryApplied,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a header parameter",
    spec: (e) =>
      `@route("/x") interface X { @get read(@header ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: (e) =>
      `[Property(ClientRuntime.HeaderPrefix + "v")] ${encoded(e)}`,
    carries: ["default", "number-as-string", "wire", "delimited"],
    cannotCarry: noLineBreaks,
  },
  {
    name: "a cookie parameter",
    spec: (e) =>
      `@route("/x") interface X { @get read(@cookie ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: (e) =>
      `[Property(ClientRuntime.CookiePrefix + "v")] ${encoded(e)}`,
    carries: ["default", "number-as-string", "wire", "delimited"],
    cannotCarry: noLineBreaks,
  },
  {
    name: "a path parameter",
    spec: (e) =>
      `@route("/x") interface X { @get read(@path ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: encoded,
    carries: ["default", "number-as-string", "wire", "delimited"],
  },
  {
    name: "a plain-text request body",
    spec: (e) =>
      `@route("/x") interface X { @post send(@body ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: (e) =>
      `[Body(BodySerializationMethod.Serialized, true)] ${encoded(e)}`,
    carries: ["default", "number-as-string", "wire"],
    wholeBody: true,
    transport: { of: requestTransport, expected: "text" },
  },
  {
    name: "a plain-text response body",
    spec: (e) =>
      `@route("/x") interface X { @get read(): { @body ${e.decorator} v: ${e.type} }; }`,
    file: "Endpoints/IX.g.cs",
    applied: (e) =>
      `[return: ClientRuntime.Encoded(ClientRuntime.WireEncoding.${e.wire})]`,
    carries: ["default", "number-as-string", "wire"],
    wholeBody: true,
    transport: { of: responseTransport, expected: "text" },
  },
  {
    name: "a JSON request body",
    spec: (e) =>
      `@route("/x") interface X { @post send(@header contentType: "application/json", @body ${e.decorator} v: ${e.type}): void; }`,
    file: "Endpoints/IX.g.cs",
    applied: encoded,
    carries: ["default"],
    wholeBody: true,
    transport: { of: requestTransport, expected: "json" },
  },
];

/**
 * What a position does with an encoding: apply it, need nothing, or report it.
 * A list body is JSON, which cannot carry a delimited format.
 *
 * @param position - The position the value travels in.
 * @param e - The encoding.
 * @returns The outcome the generated client must show.
 */
function expected(
  position: Position,
  e: Encoding,
): "applied" | "nothing" | "reported" {
  const carried =
    position.carries.includes(e.kind) &&
    !(e.kind === "delimited" && position.wholeBody);
  if (!carried || position.cannotCarry?.(e)) return "reported";
  return e.kind === "wire" || e.kind === "delimited" ? "applied" : "nothing";
}

describe("every @encode in every position is applied or reported", () => {
  for (const position of POSITIONS) {
    for (const encoding of ENCODINGS) {
      const outcome = expected(position, encoding);
      it(`${outcome === "reported" ? "reports" : outcome === "applied" ? "applies" : "accepts"} ${encoding.name} in ${position.name}`, async () => {
        const [outputs, diagnostics] = await emitWithDiagnostics(
          `${PREAMBLE}\n${position.spec(encoding)}`,
        );

        const unsupported = diagnostics.filter((d) =>
          d.code.endsWith("unsupported-encoding"),
        );
        const otherErrors = diagnostics.filter(
          (d) =>
            d.severity === "error" &&
            !d.code.endsWith("unsupported-encoding") &&
            !d.code.endsWith("unsupported-feature"),
        );
        strictEqual(
          otherErrors.length,
          0,
          otherErrors.map((d) => d.message).join("; "),
        );

        const file = Object.entries(outputs).find(([path]) =>
          path.endsWith(position.file),
        )?.[1];
        if (outcome === "reported") {
          ok(
            unsupported.length >= 1,
            `expected unsupported-encoding; got ${diagnostics.map((d) => d.message).join("; ") || "nothing"}`,
          );
          const iface =
            Object.entries(outputs).find(([path]) =>
              path.endsWith("Endpoints/IX.g.cs"),
            )?.[1] ?? "";
          ok(
            !/Task\S* \w+Async\(/.test(iface),
            `the operation must be left out:\n${iface}`,
          );
          return;
        }

        strictEqual(
          unsupported.length,
          0,
          unsupported.map((d) => d.message).join("; "),
        );
        ok(file, `${position.file} must be generated`);
        if (outcome === "applied") {
          ok(
            file.includes(position.applied(encoding)),
            `expected ${position.applied(encoding)} in ${position.file}:\n${file}`,
          );
        } else if (!(position.wholeBody && encoding.type === "bytes")) {
          // A whole body of base64 bytes travels as text, not raw bytes, which the
          // runtime may need a format to tell; the transport check covers it.
          ok(
            !/ClientRuntime\.WireEncoding\.|Converter\)\)\]|Converter<\w+>\)\)\]/.test(
              file,
            ),
            `no runtime format expected in ${position.file}:\n${file}`,
          );
        }
        if (position.transport) {
          strictEqual(
            position.transport.of(file),
            position.transport.expected,
            `${position.file} must send or read the body as ${position.transport.expected}:\n${file}`,
          );
        }
        if (
          encoding.kind === "number-as-string" &&
          position.file.startsWith("Models/")
        ) {
          ok(
            file.includes("JsonNumberHandling.WriteAsString"),
            "a number as a string is written as a string",
          );
        }
      });
    }
  }
});

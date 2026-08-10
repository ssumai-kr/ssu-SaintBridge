import type { HttpResponseHeaders } from "./http-session.js";

export type HttpTextDocumentKind = "html" | "xml";

export type HttpTextDecodingViolation =
  | "CONFLICTING_CHARSET"
  | "INVALID_CONTENT_TYPE"
  | "MALFORMED_TEXT"
  | "MISSING_CONTENT_TYPE"
  | "UNSUPPORTED_CHARSET"
  | "UNSUPPORTED_MEDIA_TYPE";

const violationMessages: Readonly<Record<HttpTextDecodingViolation, string>> = {
  CONFLICTING_CHARSET: "The upstream response contains conflicting charset declarations.",
  INVALID_CONTENT_TYPE: "The upstream response contains an invalid Content-Type header.",
  MALFORMED_TEXT: "The upstream response is not valid for its declared charset.",
  MISSING_CONTENT_TYPE: "The upstream response does not contain a Content-Type header.",
  UNSUPPORTED_CHARSET: "The upstream response declares an unsupported charset.",
  UNSUPPORTED_MEDIA_TYPE: "The upstream response is not an HTML or XML document.",
};

export class HttpTextDecodingError extends Error {
  readonly violation: HttpTextDecodingViolation;

  constructor(violation: HttpTextDecodingViolation) {
    super(violationMessages[violation]);
    this.name = "HttpTextDecodingError";
    this.violation = violation;
  }

  toJSON(): { readonly name: string; readonly violation: HttpTextDecodingViolation } {
    return { name: this.name, violation: this.violation };
  }
}

/** Decoded document whose JSON representation intentionally excludes the source text. */
export class DecodedHttpDocument {
  readonly charset: string;
  readonly kind: HttpTextDocumentKind;
  readonly mediaType: string;
  readonly text: string;

  constructor(options: {
    readonly charset: string;
    readonly kind: HttpTextDocumentKind;
    readonly mediaType: string;
    readonly text: string;
  }) {
    this.charset = options.charset;
    this.kind = options.kind;
    this.mediaType = options.mediaType;
    this.text = options.text;
  }

  toJSON(): {
    readonly charset: string;
    readonly kind: HttpTextDocumentKind;
    readonly mediaType: string;
  } {
    return {
      charset: this.charset,
      kind: this.kind,
      mediaType: this.mediaType,
    };
  }
}

export interface HttpTextResponse {
  readonly body: Uint8Array;
  readonly headers: HttpResponseHeaders;
}

const charsetAliases: Readonly<Record<string, string>> = {
  cp949: "euc-kr",
  ms949: "euc-kr",
  uhc: "euc-kr",
  "x-uhc": "euc-kr",
  "x-windows-949": "euc-kr",
};

const mediaTypePattern = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const charsetParameterPattern = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/gi;
const attributePattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const contentTypeValues = (headers: HttpResponseHeaders): readonly string[] =>
  Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "content-type")
    .flatMap(([, values]) => values);

const charsetParameters = (value: string): readonly string[] => {
  const labels: string[] = [];
  for (const match of value.matchAll(charsetParameterPattern)) {
    const label = match[1] ?? match[2] ?? match[3];
    if (label === undefined || label.trim().length === 0) {
      throw new HttpTextDecodingError("INVALID_CONTENT_TYPE");
    }
    labels.push(label);
  }
  if (/(?:^|;)\s*charset\b/i.test(value) && labels.length === 0) {
    throw new HttpTextDecodingError("INVALID_CONTENT_TYPE");
  }
  return labels;
};

const parseContentType = (
  headers: HttpResponseHeaders,
): { readonly charsetLabels: readonly string[]; readonly mediaType: string } => {
  const values = contentTypeValues(headers);
  if (values.length === 0) throw new HttpTextDecodingError("MISSING_CONTENT_TYPE");
  if (values.length !== 1) throw new HttpTextDecodingError("INVALID_CONTENT_TYPE");

  const value = values[0];
  if (value === undefined) throw new HttpTextDecodingError("INVALID_CONTENT_TYPE");
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || !mediaTypePattern.test(mediaType)) {
    throw new HttpTextDecodingError("INVALID_CONTENT_TYPE");
  }

  const charsetLabels = charsetParameters(value);
  return { charsetLabels, mediaType };
};

const documentKind = (mediaType: string): HttpTextDocumentKind => {
  if (mediaType === "text/html") return "html";
  if (mediaType === "application/xml" || mediaType === "text/xml" || mediaType.endsWith("+xml")) {
    return "xml";
  }
  throw new HttpTextDecodingError("UNSUPPORTED_MEDIA_TYPE");
};

const detectBomCharset = (body: Uint8Array): string | undefined => {
  if (body[0] === 0x00 && body[1] === 0x00 && body[2] === 0xfe && body[3] === 0xff) {
    throw new HttpTextDecodingError("UNSUPPORTED_CHARSET");
  }
  if (body[0] === 0xff && body[1] === 0xfe && body[2] === 0x00 && body[3] === 0x00) {
    throw new HttpTextDecodingError("UNSUPPORTED_CHARSET");
  }
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  return undefined;
};

const scanPrefix = (body: Uint8Array, bomCharset: string | undefined): string => {
  const prefix = body.subarray(0, 1_024);
  if (bomCharset !== undefined) return new TextDecoder(bomCharset).decode(prefix);
  return Buffer.from(prefix).toString("latin1");
};

const parseAttributes = (source: string): ReadonlyMap<string, readonly string[]> => {
  const attributes = new Map<string, string[]>();
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    if (name === undefined) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    const values = attributes.get(name) ?? [];
    values.push(value);
    attributes.set(name, values);
  }
  return attributes;
};

const htmlCharsetLabels = (prefix: string): readonly string[] => {
  const labels: string[] = [];
  const searchable = prefix
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");

  for (const match of searchable.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0].replace(/^<meta\b/i, "").replace(/>$/, "");
    const attributes = parseAttributes(tag);
    labels.push(...(attributes.get("charset") ?? []));

    const httpEquiv = attributes.get("http-equiv") ?? [];
    if (!httpEquiv.some((value) => value.trim().toLowerCase() === "content-type")) continue;
    for (const content of attributes.get("content") ?? []) {
      labels.push(...charsetParameters(content));
    }
  }
  return labels;
};

const xmlCharsetLabels = (prefix: string): readonly string[] => {
  const declaration = /^\s*<\?xml\b([\s\S]*?)\?>/i.exec(prefix);
  if (declaration?.[1] === undefined) return [];
  return parseAttributes(declaration[1]).get("encoding") ?? [];
};

const canonicalCharset = (label: string, bomCharset: string | undefined): string => {
  const normalized = label.trim().toLowerCase();
  if (normalized.length === 0) throw new HttpTextDecodingError("UNSUPPORTED_CHARSET");
  if (normalized === "utf-16" && bomCharset?.startsWith("utf-16") === true) return bomCharset;
  const aliased = charsetAliases[normalized] ?? normalized;
  try {
    return new TextDecoder(aliased).encoding;
  } catch {
    throw new HttpTextDecodingError("UNSUPPORTED_CHARSET");
  }
};

const resolveCharset = (labels: readonly string[], bomCharset: string | undefined): string => {
  const canonical = new Set(labels.map((label) => canonicalCharset(label, bomCharset)));
  if (canonical.size > 1) throw new HttpTextDecodingError("CONFLICTING_CHARSET");
  return canonical.values().next().value ?? "utf-8";
};

/**
 * Decodes an HTML or XML response using Content-Type, BOM, then in-document declarations.
 * Ambiguous declarations and malformed byte sequences fail closed with a serializable safe error.
 */
export const decodeHttpTextResponse = (response: HttpTextResponse): DecodedHttpDocument => {
  const contentType = parseContentType(response.headers);
  const kind = documentKind(contentType.mediaType);
  const bomCharset = detectBomCharset(response.body);
  const prefix = scanPrefix(response.body, bomCharset);
  const documentLabels = kind === "html" ? htmlCharsetLabels(prefix) : xmlCharsetLabels(prefix);
  const charset = resolveCharset(
    [
      ...contentType.charsetLabels,
      ...(bomCharset === undefined ? [] : [bomCharset]),
      ...documentLabels,
    ],
    bomCharset,
  );

  let text: string;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(response.body);
  } catch {
    throw new HttpTextDecodingError("MALFORMED_TEXT");
  }

  return new DecodedHttpDocument({
    charset,
    kind,
    mediaType: contentType.mediaType,
    text,
  });
};

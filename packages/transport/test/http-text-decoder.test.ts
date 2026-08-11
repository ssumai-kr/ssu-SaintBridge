import { describe, expect, it } from "vitest";

import {
  decodeHttpTextResponse,
  DecodedHttpDocument,
  HttpTextDecodingError,
  type HttpResponseHeaders,
} from "../src/index.js";

const response = (
  body: Uint8Array | string,
  contentType?: string,
  headers?: HttpResponseHeaders,
) => ({
  body: typeof body === "string" ? new TextEncoder().encode(body) : body,
  headers:
    headers ?? (contentType === undefined ? {} : { "content-type": Object.freeze([contentType]) }),
});

const joinBytes = (...parts: readonly (string | readonly number[])[]): Uint8Array =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part, "ascii") : Buffer.from(part),
    ),
  );

const koreanSchoolNameEucKr = [0xbc, 0xfe, 0xbd, 0xc7, 0xb4, 0xeb, 0xc7, 0xd0, 0xb1, 0xb3];

const utf16BigEndian = (value: string): Uint8Array => {
  const bytes = new Uint8Array(2 + value.length * 2);
  bytes.set([0xfe, 0xff]);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[2 + index * 2] = codeUnit >> 8;
    bytes[3 + index * 2] = codeUnit & 0xff;
  }
  return bytes;
};

describe("decodeHttpTextResponse", () => {
  it("decodes UTF-8 HTML from the Content-Type header", () => {
    const document = decodeHttpTextResponse(
      response("<html><body>테스트</body></html>", "text/html; charset=UTF-8"),
    );

    expect(document).toBeInstanceOf(DecodedHttpDocument);
    expect(document).toMatchObject({
      charset: "utf-8",
      kind: "html",
      mediaType: "text/html",
      text: "<html><body>테스트</body></html>",
    });
    expect(JSON.stringify(document)).toBe(
      '{"charset":"utf-8","kind":"html","mediaType":"text/html"}',
    );
    expect(JSON.stringify({ ...document })).toBe(
      '{"charset":"utf-8","kind":"html","mediaType":"text/html"}',
    );
    expect(Object.keys(document)).not.toContain("text");
  });

  it("detects EUC-KR from an HTML meta element", () => {
    const body = joinBytes(
      '<html><head><meta charset="euc-kr"></head><body>',
      koreanSchoolNameEucKr,
      "</body></html>",
    );

    const document = decodeHttpTextResponse(response(body, "text/html"));

    expect(document.charset).toBe("euc-kr");
    expect(document.text).toContain("숭실대학교");
  });

  it("supports a legacy HTML http-equiv charset declaration", () => {
    const body = joinBytes(
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=MS949"></head><body>',
      koreanSchoolNameEucKr,
      "</body></html>",
    );

    const document = decodeHttpTextResponse(response(body, "text/html"));

    expect(document.charset).toBe("euc-kr");
    expect(document.text).toContain("숭실대학교");
  });

  it.each(["MS949", "CP949", "UHC", "x-windows-949"])(
    "normalizes the Korean charset alias %s",
    (charset) => {
      const body = joinBytes("<html><body>", koreanSchoolNameEucKr, "</body></html>");

      const document = decodeHttpTextResponse(response(body, `text/html; charset=${charset}`));

      expect(document.charset).toBe("euc-kr");
      expect(document.text).toContain("숭실대학교");
    },
  );

  it("detects an XML declaration", () => {
    const body = joinBytes(
      '<?xml version="1.0" encoding="euc-kr"?><portal>',
      koreanSchoolNameEucKr,
      "</portal>",
    );

    const document = decodeHttpTextResponse(response(body, "application/xml"));

    expect(document).toMatchObject({ charset: "euc-kr", kind: "xml" });
    expect(document.text).toContain("숭실대학교");
  });

  it("uses a UTF-8 BOM when no charset is declared", () => {
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<html><body>테스트</body></html>"),
    ]);

    const document = decodeHttpTextResponse(response(body, "text/html"));

    expect(document.charset).toBe("utf-8");
    expect(document.text).toBe("<html><body>테스트</body></html>");
  });

  it("uses a UTF-16 BOM to resolve a generic XML encoding declaration", () => {
    const body = utf16BigEndian('<?xml version="1.0" encoding="UTF-16"?><portal>테스트</portal>');

    const document = decodeHttpTextResponse(response(body, "application/xml"));

    expect(document.charset).toBe("utf-16be");
    expect(document.text).toContain("<portal>테스트</portal>");
  });

  it("ignores charset-like meta elements inside comments", () => {
    const body = '<!-- <meta charset="euc-kr"> --><html><body>테스트</body></html>';

    const document = decodeHttpTextResponse(response(body, "text/html"));

    expect(document.charset).toBe("utf-8");
    expect(document.text).toContain("테스트");
  });

  it("rejects conflicting header and document charset declarations", () => {
    const body = '<html><head><meta charset="euc-kr"></head></html>';

    expect(() => decodeHttpTextResponse(response(body, "text/html; charset=utf-8"))).toThrowError(
      expect.objectContaining({ violation: "CONFLICTING_CHARSET" }),
    );
  });

  it("rejects unsupported charsets without exposing the label", () => {
    let captured: unknown;
    try {
      decodeHttpTextResponse(response("<html></html>", "text/html; charset=secret-encoding"));
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(HttpTextDecodingError);
    expect(captured).toMatchObject({ violation: "UNSUPPORTED_CHARSET" });
    expect(JSON.stringify(captured)).not.toContain("secret-encoding");
  });

  it("rejects malformed bytes for the resolved charset", () => {
    expect(() =>
      decodeHttpTextResponse(response(new Uint8Array([0xc3, 0x28]), "text/html; charset=utf-8")),
    ).toThrowError(expect.objectContaining({ violation: "MALFORMED_TEXT" }));
  });

  it("requires one valid HTML or XML Content-Type header", () => {
    expect(() => decodeHttpTextResponse(response("<html></html>"))).toThrowError(
      expect.objectContaining({ violation: "MISSING_CONTENT_TYPE" }),
    );
    expect(() =>
      decodeHttpTextResponse(response("plain", "text/plain; charset=utf-8")),
    ).toThrowError(expect.objectContaining({ violation: "UNSUPPORTED_MEDIA_TYPE" }));
    expect(() =>
      decodeHttpTextResponse(
        response("<html></html>", undefined, {
          "content-type": ["text/html", "application/xml"],
        }),
      ),
    ).toThrowError(expect.objectContaining({ violation: "INVALID_CONTENT_TYPE" }));
    expect(() =>
      decodeHttpTextResponse(response("<html></html>", "text/html; charset=")),
    ).toThrowError(expect.objectContaining({ violation: "INVALID_CONTENT_TYPE" }));
  });
});

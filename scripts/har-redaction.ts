type JsonRecord = Record<string, unknown>;

const sensitiveHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-csrf-token",
  "x-sap-wd-secure-id",
  "x-xsrf-token",
]);

const credentialFields = new Set([
  "password",
  "passwd",
  "pwd",
  "userpassword",
  "userpw",
  "jpassword",
]);
const tokenFields = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "ssotoken",
  "callbacktoken",
  "csrftoken",
  "xsrftoken",
  "secureid",
  "contextid",
  "sessionid",
  "jsessionid",
  "sapwdsecureid",
]);
const studentIdFields = new Set([
  "studentid",
  "studentnumber",
  "studentno",
  "hakbun",
  "학번",
  "userid",
  "username",
  "loginid",
  "jusername",
]);
const studentNameFields = new Set([
  "studentname",
  "fullname",
  "koreanname",
  "englishname",
  "성명",
  "이름",
]);
const emailFields = new Set(["email", "emailaddress", "mail"]);
const phoneFields = new Set(["phone", "phonenumber", "mobile", "mobilephone", "tel"]);
const addressFields = new Set(["address", "homeaddress", "주소"]);
const personalIdFields = new Set([
  "residentregistrationnumber",
  "registrationnumber",
  "rrn",
  "주민등록번호",
]);
const academicDataFields = new Set([
  "grade",
  "gradepoint",
  "gpa",
  "score",
  "scholarship",
  "scholarshipamount",
  "tuition",
  "tuitionamount",
]);

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeFieldName = (name: string): string => name.toLowerCase().replace(/[\s._-]/g, "");

export const redactionForField = (name: string): string | null => {
  const normalized = normalizeFieldName(name);
  if (credentialFields.has(normalized)) return "[REDACTED:PASSWORD]";
  if (tokenFields.has(normalized)) return "[REDACTED:TOKEN]";
  if (studentIdFields.has(normalized)) return "[REDACTED:STUDENT_ID]";
  if (studentNameFields.has(normalized)) return "[REDACTED:NAME]";
  if (emailFields.has(normalized)) return "[REDACTED:EMAIL]";
  if (phoneFields.has(normalized)) return "[REDACTED:PHONE]";
  if (addressFields.has(normalized)) return "[REDACTED:ADDRESS]";
  if (personalIdFields.has(normalized)) return "[REDACTED:PERSONAL_ID]";
  if (academicDataFields.has(normalized)) return "[REDACTED:ACADEMIC_DATA]";
  return null;
};

const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.pathname = redactText(url.pathname);
    if (url.hash.length > 0) url.hash = "#[REDACTED:FRAGMENT]";
    for (const name of [...url.searchParams.keys()]) {
      const replacement = redactionForField(name);
      if (replacement !== null) {
        url.searchParams.set(name, replacement);
      } else {
        url.searchParams.set(name, redactText(url.searchParams.get(name) ?? ""));
      }
    }
    return url.toString();
  } catch {
    return redactText(value);
  }
};

const redactFormText = (value: string): string => {
  const params = new URLSearchParams(value);
  for (const name of [...params.keys()]) {
    const replacement = redactionForField(name);
    if (replacement !== null) {
      params.set(name, replacement);
    } else {
      params.set(name, redactText(params.get(name) ?? ""));
    }
  }
  return params.toString();
};

export const redactText = (value: string): string =>
  value
    .replace(/CANARY_(?:PASSWORD|COOKIE|TOKEN|SECRET)_[A-Za-z0-9_-]{8,}/g, "[REDACTED:SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED:TOKEN]")
    .replace(/\b\d{6}-[1-4]\d{6}\b/g, "[REDACTED:PERSONAL_ID]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED:EMAIL]")
    .replace(/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g, "[REDACTED:PHONE]")
    .replace(/\b\d{8,10}\b/g, "[REDACTED:STUDENT_ID]")
    .replace(
      /((?:password|passwd|pwd|token|session_?id|jsessionid|student_?id|student_?number|user_?id|username)\s*[=:]\s*)[^&\s"'<>]+/gi,
      "$1[REDACTED]",
    );

const sanitizeNamedValues = (value: unknown): unknown => {
  if (!Array.isArray(value)) return sanitizeHarValue(value);

  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      return sanitizeHarValue(entry);
    }

    const replacement = redactionForField(entry.name);
    return {
      ...sanitizeRecord(entry),
      ...(replacement === null ? {} : { value: replacement }),
    };
  });
};

const sanitizeHeaders = (value: unknown): unknown => {
  if (!Array.isArray(value)) return sanitizeHarValue(value);

  return value
    .filter(
      (entry) =>
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !sensitiveHeaders.has(entry.name.toLowerCase()),
    )
    .map((entry) => sanitizeHarValue(entry));
};

const sanitizeEmbeddedText = (value: string, record: JsonRecord): string => {
  if (record.encoding === "base64") {
    return "[REDACTED:BINARY_CONTENT]";
  }

  const mimeType = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
  if (mimeType.includes("application/x-www-form-urlencoded")) {
    return redactFormText(value);
  }

  if (mimeType.includes("json") || /^\s*(?:\[|\{)/.test(value)) {
    try {
      return JSON.stringify(sanitizeHarValue(JSON.parse(value) as unknown));
    } catch {
      // Malformed upstream content still receives conservative text redaction below.
    }
  }

  return redactText(value);
};

const sanitizeRecord = (record: JsonRecord): JsonRecord =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const normalizedKey = normalizeFieldName(key);
      const directReplacement = redactionForField(key);

      if (directReplacement !== null) return [key, directReplacement];
      if (normalizedKey === "headers") return [key, sanitizeHeaders(value)];
      if (normalizedKey === "cookies") return [key, []];
      if (normalizedKey === "querystring" || normalizedKey === "params") {
        return [key, sanitizeNamedValues(value)];
      }
      if (normalizedKey === "url" && typeof value === "string") {
        return [key, redactUrl(value)];
      }
      if (normalizedKey === "text" && typeof value === "string") {
        return [key, sanitizeEmbeddedText(value, record)];
      }
      return [key, sanitizeHarValue(value)];
    }),
  );

export const sanitizeHarValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => sanitizeHarValue(entry));
  if (isRecord(value)) return sanitizeRecord(value);
  if (typeof value === "string") return redactText(value);
  return value;
};

export const sanitizeHar = (har: unknown): unknown => {
  if (!isRecord(har) || !isRecord(har.log) || !Array.isArray(har.log.entries)) {
    throw new TypeError("Input is not a valid HAR object with log.entries.");
  }
  return sanitizeHarValue(har);
};

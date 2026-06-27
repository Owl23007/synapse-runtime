export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

export function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable payload]";
  }
}

export function parseJsonPayload(data: unknown): unknown {
  if (typeof data === "string") {
    return JSON.parse(data);
  }

  if (Buffer.isBuffer(data)) {
    return JSON.parse(data.toString("utf8"));
  }

  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString("utf8"));
  }

  if (Array.isArray(data)) {
    return JSON.parse(
      Buffer.concat(
        data.map((part) => {
          if (Buffer.isBuffer(part)) {
            return part;
          }

          if (part instanceof ArrayBuffer) {
            return Buffer.from(part);
          }

          return Buffer.from(String(part));
        })
      ).toString("utf8")
    );
  }

  return data;
}

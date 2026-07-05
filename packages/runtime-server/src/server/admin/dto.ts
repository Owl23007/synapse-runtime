export interface ChannelAdminPatch {
  readonly enabled?: boolean;
}

export function isChannelAdminPatch(value: unknown): value is ChannelAdminPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Readonly<Record<string, unknown>>;
  return record.enabled === undefined || typeof record.enabled === "boolean";
}

export function parsePositiveInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

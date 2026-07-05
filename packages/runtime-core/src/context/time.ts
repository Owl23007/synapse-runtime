export function formatZonedTimestamp(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  const effectiveDate = Number.isNaN(date.getTime()) ? new Date() : date;

  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset"
    }).format(effectiveDate);
  } catch {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset"
    }).format(effectiveDate);
  }
}

export function splitCommand(command: string): string[] {
  const matches = command.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
  return matches.map((match) => {
    if ((match.startsWith('"') && match.endsWith('"')) || (match.startsWith("'") && match.endsWith("'"))) {
      return match.slice(1, -1);
    }

    return match;
  });
}

export function parseAssignments(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const value of values) {
    const separator = value.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    result[value.slice(0, separator)] = value.slice(separator + 1);
  }

  return result;
}

export function parseCommandValue(value: string): unknown {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  const number = Number(value);

  if (Number.isFinite(number) && value.trim() !== "") {
    return number;
  }

  return value;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

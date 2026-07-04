import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const content = readFileSync(resolve(filePath), "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = stripEnvQuotes(line.slice(separator + 1).trim());

    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

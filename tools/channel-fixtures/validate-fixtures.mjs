import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "../..");
const FIXTURE_ROOT = join(REPOSITORY_ROOT, "fixtures");
const CHANNELS = new Set(["onebot11", "qq-official", "cli"]);
const DIRECTIONS = new Set(["inbound", "outbound", "errors"]);
const STATUSES = new Set([
  "documented",
  "tested-supported",
  "tested-partial",
  "tested-unsupported",
  "unstable",
  "blocked",
  "unknown"
]);
const PROVENANCE_KINDS = new Set(["official-documentation", "real-api-capture", "local-terminal-capture", "synthetic"]);
const SECRET_KEY =
  /(?:access[_-]?token|app[_-]?secret|client[_-]?secret|authorization|cookie|password|private[_-]?key|signature)/i;
const SECRET_VALUE =
  /(?:Bearer\s+[^\[]|QQBot\s+[^\[]|sk-[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const REDACTED = "[REDACTED]";

const errors = [];
const fixtures = [];
const fixtureIds = new Map();

const requiredDirectories = [...CHANNELS].flatMap((channel) =>
  [...DIRECTIONS].map((direction) => join(FIXTURE_ROOT, channel, direction))
);
const directoryChecks = await Promise.all(
  requiredDirectories.map(async (directory) => ({ directory, exists: await isDirectory(directory) }))
);
for (const { directory, exists } of directoryChecks) {
  if (!exists) {
    errors.push(`Missing required directory: ${relative(REPOSITORY_ROOT, directory)}`);
  }
}

const fixtureReads = await Promise.all(
  (await findFixtureFiles(FIXTURE_ROOT)).map(async (path) => {
    try {
      return { path, fixture: JSON.parse(await readFile(path, "utf8")) };
    } catch (error) {
      return { path, error };
    }
  })
);

for (const { path, fixture, error } of fixtureReads) {
  if (error !== undefined) {
    errors.push(`${relative(REPOSITORY_ROOT, path)}: invalid JSON (${error.message})`);
  } else {
    validateAndCollectFixture(path, fixture);
  }
}

function validateAndCollectFixture(path, fixture) {
  validateFixture(path, fixture);
  if (typeof fixture.id === "string") {
    const previousPath = fixtureIds.get(fixture.id);
    if (previousPath !== undefined) {
      errors.push(
        `${relative(REPOSITORY_ROOT, path)}: duplicate id ${fixture.id} (also used by ${relative(REPOSITORY_ROOT, previousPath)})`
      );
    } else {
      fixtureIds.set(fixture.id, path);
    }
  }
  fixtures.push(fixture);
}

if (errors.length > 0) {
  console.error("Channel protocol fixture validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  const counts = fixtures.reduce((result, fixture) => {
    const key = `${fixture.channel}/${fixture.direction}/${fixture.status}`;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});

  console.log(`Validated ${fixtures.length} channel protocol fixture(s).`);
  for (const [key, count] of Object.entries(counts).toSorted()) {
    console.log(`- ${key}: ${count}`);
  }
}

function validateFixture(path, fixture) {
  const label = relative(REPOSITORY_ROOT, path);
  if (!isRecord(fixture)) {
    errors.push(`${label}: fixture root must be an object`);
    return;
  }

  requireString(label, fixture, "schemaVersion", "channel-protocol-fixture/v1");
  requireString(label, fixture, "id");
  requireEnum(label, fixture, "channel", CHANNELS);
  requireEnum(label, fixture, "direction", DIRECTIONS);
  requireString(label, fixture, "capability");
  requireEnum(label, fixture, "status", STATUSES);
  requireString(label, fixture, "capturedAt");
  requireString(label, fixture, "conclusion");

  if (typeof fixture.capturedAt === "string" && Number.isNaN(Date.parse(fixture.capturedAt))) {
    errors.push(`${label}: capturedAt must be an ISO-8601 timestamp`);
  }

  const parts = relative(FIXTURE_ROOT, path).split(/[\\/]/);
  if (fixture.channel !== parts[0] || fixture.direction !== parts[1]) {
    errors.push(`${label}: channel/direction metadata must match its directory`);
  }

  if (!isRecord(fixture.provenance)) {
    errors.push(`${label}: provenance must be an object`);
  } else {
    requireEnum(`${label} provenance`, fixture.provenance, "kind", PROVENANCE_KINDS);
    requireString(`${label} provenance`, fixture.provenance, "source");
  }

  if (!isRecord(fixture.environment)) {
    errors.push(`${label}: environment must be an object`);
  }

  if (!Array.isArray(fixture.redactions)) {
    errors.push(`${label}: redactions must be an array`);
  }

  if (!Array.isArray(fixture.limitations)) {
    errors.push(`${label}: limitations must be an array`);
  }

  if (!isRecord(fixture.artifacts)) {
    errors.push(`${label}: artifacts must be an object`);
  } else if (fixture.direction === "inbound" && fixture.artifacts.platformEvent === undefined) {
    errors.push(`${label}: inbound fixture requires artifacts.platformEvent`);
  } else if (
    (fixture.direction === "outbound" || fixture.direction === "errors") &&
    fixture.artifacts.platformRequest === undefined
  ) {
    errors.push(`${label}: outbound/error fixture requires artifacts.platformRequest`);
  }

  if (String(fixture.status).startsWith("tested-") || fixture.status === "unstable") {
    const kind = fixture.provenance?.kind;
    if (kind !== "real-api-capture" && kind !== "local-terminal-capture") {
      errors.push(`${label}: tested/unstable status requires real-api-capture or local-terminal-capture provenance`);
    }
  }

  if (fixture.status === "documented" && fixture.provenance?.kind !== "official-documentation") {
    errors.push(`${label}: documented status requires official-documentation provenance`);
  }

  scanForSecrets(label, fixture);
}

function requireString(label, object, key, expected) {
  if (typeof object[key] !== "string" || object[key].length === 0) {
    errors.push(`${label}: ${key} must be a non-empty string`);
  } else if (expected !== undefined && object[key] !== expected) {
    errors.push(`${label}: ${key} must equal ${expected}`);
  }
}

function requireEnum(label, object, key, values) {
  if (!values.has(object[key])) {
    errors.push(`${label}: ${key} must be one of ${[...values].join(", ")}`);
  }
}

function scanForSecrets(label, value, key = "root") {
  if (typeof value === "string") {
    if (SECRET_KEY.test(key) && value !== REDACTED) {
      errors.push(`${label}: sensitive field ${key} must equal ${REDACTED}`);
    } else if (SECRET_VALUE.test(value)) {
      errors.push(`${label}: value at ${key} resembles an unredacted credential`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(label, item, `${key}[${index}]`));
    return;
  }

  if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      scanForSecrets(label, childValue, childKey);
    }
  }
}

async function findFixtureFiles(directory) {
  if (!(await isDirectory(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return findFixtureFiles(path);
      }

      return Promise.resolve(entry.isFile() && entry.name.endsWith(".fixture.json") ? [path] : []);
    })
  );
  return nested.flat();
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

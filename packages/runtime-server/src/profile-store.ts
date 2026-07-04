import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimeCliProfile {
  readonly endpoint: string;
  readonly token?: string;
}

export interface RuntimeCliProfileConfig {
  readonly current?: string;
  readonly profiles: Readonly<Record<string, RuntimeCliProfile>>;
}

export interface RuntimeConnection {
  readonly endpoint: string;
  readonly token?: string;
  readonly profile?: string;
}

export interface RuntimeConnectionOptions {
  readonly endpoint?: string;
  readonly token?: string;
  readonly profile?: string;
  readonly profilePath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export const DEFAULT_RUNTIME_ENDPOINT = "http://127.0.0.1:3766";

export function getDefaultProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNAPSE_CLI_CONFIG ?? join(homedir(), ".synapse", "cli.json");
}

export async function loadProfileConfig(profilePath = getDefaultProfilePath()): Promise<RuntimeCliProfileConfig> {
  let content: string;

  try {
    content = await readFile(profilePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { profiles: {} };
    }

    throw error;
  }

  const parsed = JSON.parse(content) as unknown;
  return parseProfileConfig(parsed);
}

export async function saveProfileConfig(
  config: RuntimeCliProfileConfig,
  profilePath = getDefaultProfilePath()
): Promise<void> {
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function connectProfile(options: {
  readonly endpoint: string;
  readonly token?: string;
  readonly profile?: string;
  readonly profilePath?: string;
}): Promise<RuntimeCliProfileConfig> {
  const profileName = options.profile ?? "local";
  assertProfileName(profileName);
  const config = await loadProfileConfig(options.profilePath);
  const next: RuntimeCliProfileConfig = {
    current: profileName,
    profiles: {
      ...config.profiles,
      [profileName]: {
        endpoint: options.endpoint,
        ...(options.token === undefined ? {} : { token: options.token })
      }
    }
  };
  await saveProfileConfig(next, options.profilePath);
  return next;
}

export async function useProfile(profileName: string, profilePath?: string): Promise<RuntimeCliProfileConfig> {
  assertProfileName(profileName);
  const config = await loadProfileConfig(profilePath);

  if (config.profiles[profileName] === undefined) {
    throw new Error(`Runtime profile "${profileName}" is not configured.`);
  }

  const next = {
    ...config,
    current: profileName
  };
  await saveProfileConfig(next, profilePath);
  return next;
}

export async function resolveRuntimeConnection(options: RuntimeConnectionOptions = {}): Promise<RuntimeConnection> {
  const env = options.env ?? process.env;
  const profilePath = options.profilePath ?? getDefaultProfilePath(env);
  const config = await loadProfileConfig(profilePath);
  const selectedProfileName =
    options.profile ??
    (options.endpoint === undefined && env.SYNAPSE_RUNTIME_URL === undefined ? config.current : undefined);
  const selectedProfile = selectedProfileName === undefined ? undefined : config.profiles[selectedProfileName];
  const token = options.token ?? env.SYNAPSE_RUNTIME_TOKEN ?? selectedProfile?.token;

  if (selectedProfileName !== undefined && selectedProfile === undefined) {
    throw new Error(`Runtime profile "${selectedProfileName}" is not configured.`);
  }

  return {
    endpoint: options.endpoint ?? selectedProfile?.endpoint ?? env.SYNAPSE_RUNTIME_URL ?? DEFAULT_RUNTIME_ENDPOINT,
    ...(token === undefined ? {} : { token }),
    ...(selectedProfileName === undefined ? {} : { profile: selectedProfileName })
  };
}

function parseProfileConfig(value: unknown): RuntimeCliProfileConfig {
  if (!isRecord(value)) {
    throw new Error("Runtime CLI profile config must be a JSON object.");
  }

  const current = typeof value.current === "string" && value.current.length > 0 ? value.current : undefined;
  const rawProfiles = isRecord(value.profiles) ? value.profiles : {};
  const profiles: Record<string, RuntimeCliProfile> = {};

  for (const [profileName, profile] of Object.entries(rawProfiles)) {
    assertProfileName(profileName);

    if (!isRecord(profile) || typeof profile.endpoint !== "string" || profile.endpoint.length === 0) {
      throw new Error(`Runtime profile "${profileName}" must include a non-empty endpoint.`);
    }

    profiles[profileName] = {
      endpoint: profile.endpoint,
      ...(typeof profile.token === "string" && profile.token.length > 0 ? { token: profile.token } : {})
    };
  }

  if (current !== undefined && profiles[current] === undefined) {
    throw new Error(`Current runtime profile "${current}" is not configured.`);
  }

  return {
    ...(current === undefined ? {} : { current }),
    profiles
  };
}

function assertProfileName(profileName: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profileName)) {
    throw new Error(
      "Runtime profile name must start with a letter or number and contain only letters, numbers, _ or -."
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

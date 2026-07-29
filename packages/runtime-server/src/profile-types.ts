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

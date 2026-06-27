import { redactConfig, type RuntimeConfig } from "@synapse/runtime-config";
import { Box, Text, useApp, useInput } from "ink";
import { createElement, useEffect, useMemo, useState, type ReactElement } from "react";
import type { RuntimeConsoleController } from "./controller.js";
import type { ConsoleLevel, ConsoleLogEntry, ConsoleState } from "./types.js";

export function RuntimeConsoleApp({ controller }: { readonly controller: RuntimeConsoleController }): ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState(controller.snapshot);
  const [draft, setDraft] = useState("");

  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => {
    void controller.start();
  }, [controller]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      void controller.stop().finally(exit);
      return;
    }

    if (key.return) {
      const command = draft;
      setDraft("");
      void controller.execute(command).then((result) => {
        if (result === "exit") {
          exit();
        }
      });
      return;
    }

    if (key.backspace || key.delete) {
      setDraft((current) => current.slice(0, -1));
      return;
    }

    if (key.tab || key.escape || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0) {
      setDraft((current) => `${current}${input.replace(/\r?\n/g, "")}`);
    }
  });

  const body = useMemo(() => renderBody(state), [state]);

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    createElement(Header, { state }),
    createElement(Box, { marginTop: 1, flexDirection: "column" }, body),
    createElement(NoticePanel, { notices: state.notices }),
    createElement(Text, { color: "cyan" }, `> ${draft}`)
  );
}

function Header({ state }: { readonly state: ConsoleState }) {
  const server = state.started === undefined ? "not listening" : `${state.started.host}:${state.started.port}`;
  const logLevel = state.config?.runtime.logLevel ?? "unknown";

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { bold: true }, "Synapse Runtime Console"),
    createElement(Text, null, `status ${state.status}   server ${server}   logLevel ${logLevel}   view ${state.view}`)
  );
}

function NoticePanel({ notices }: { readonly notices: readonly string[] }) {
  return createElement(
    Box,
    { marginTop: 1, flexDirection: "column" },
    ...notices.slice(-3).map((notice, index) => createElement(Text, { key: index, color: "yellow" }, notice))
  );
}

function renderBody(state: ConsoleState) {
  if (state.view === "help") {
    return createElement(
      Box,
      { flexDirection: "column" },
      ...[
        "/status                         Show runtime status",
        "/logs                           Show buffered runtime logs",
        "/config                         Show redacted effective config",
        "/channels                       Show configured channels",
        "/reload                         Reload config from disk for viewing",
        "/channel enable <id>            Set channels.<id>.enabled=true",
        "/channel disable <id>           Set channels.<id>.enabled=false",
        "/channel set <id> <key> <value> Update one channel field",
        "/channel add-qq-official <id> appId=<id> appSecret=<secret>",
        "/quit                           Stop runtime and exit"
      ].map((line) => createElement(Text, { key: line }, line))
    );
  }

  if (state.view === "logs") {
    return createElement(LogPanel, { logs: state.logs, expanded: true });
  }

  if (state.view === "config") {
    return createElement(ConfigPanel, { config: state.config });
  }

  if (state.view === "channels") {
    return createElement(ChannelPanel, { config: state.config });
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(ChannelPanel, { config: state.config }),
    createElement(Box, { marginTop: 1 }, createElement(Text, { bold: true }, "Recent Logs")),
    createElement(LogPanel, { logs: state.logs.slice(-8), expanded: false })
  );
}

function ChannelPanel({ config }: { readonly config: RuntimeConfig | undefined }) {
  const channels = Object.entries(config?.channels ?? {});

  if (channels.length === 0) {
    return createElement(Text, { color: "gray" }, "No channels configured.");
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { bold: true }, "Channels"),
    ...channels.map(([channelId, channel]) => {
      const mode = channel.adapter === "qq-official" ? channel.mode : channel.transport;
      const target = channel.adapter === "qq-official" ? channel.webhookPath ?? "-" : channel.endpoint;
      return createElement(
        Text,
        { key: channelId, color: channel.enabled ? "green" : "gray" },
        `${channelId.padEnd(18)} ${String(channel.enabled).padEnd(5)} ${channel.adapter.padEnd(12)} ${mode} ${target}`
      );
    })
  );
}

function LogPanel({ logs, expanded }: { readonly logs: readonly ConsoleLogEntry[]; readonly expanded: boolean }) {
  const visible = expanded ? logs.slice(-20) : logs;

  if (visible.length === 0) {
    return createElement(Text, { color: "gray" }, "No logs yet.");
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    ...visible.map((entry) => {
      const metadata = expanded && entry.metadata !== undefined ? ` ${formatMetadata(entry.metadata)}` : "";
      return createElement(
        Text,
        { key: entry.id, color: levelColor(entry.level) },
        `${formatTime(entry.timestamp)} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${metadata}`
      );
    })
  );
}

function ConfigPanel({ config }: { readonly config: RuntimeConfig | undefined }) {
  if (config === undefined) {
    return createElement(Text, { color: "gray" }, "Config not loaded.");
  }

  const redacted = redactConfig(config);
  const lines = JSON.stringify(redacted, null, 2).split("\n").slice(0, 24);

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { bold: true }, "Config"),
    ...lines.map((line, index) => createElement(Text, { key: index }, line)),
    createElement(Text, { color: "gray" }, "Showing first 24 lines, secrets redacted.")
  );
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function formatMetadata(metadata: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(metadata);
}

function levelColor(level: ConsoleLevel): "gray" | "blue" | "yellow" | "red" {
  if (level === "debug") {
    return "gray";
  }

  if (level === "warn") {
    return "yellow";
  }

  if (level === "error") {
    return "red";
  }

  return "blue";
}

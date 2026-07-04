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
      void (async () => {
        const result = await controller.execute(command);
        if (result === "exit") {
          exit();
        }
      })();
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
    createElement(Text, { bold: true, color: "cyan" }, "Synapse Runtime 控制台"),
    createElement(
      Text,
      null,
      `状态 ${formatStatus(state.status)}   服务 ${server}   Admin ${state.endpoint ?? "-"}   日志级别 ${logLevel}   视图 ${formatView(state.view)}`
    )
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
        "/status                         刷新运行状态",
        "/logs                           查看最近日志",
        "/config                         查看脱敏后的运行配置",
        "/channels                       查看频道状态",
        "/reload                         通过 Admin API 重载配置",
        "/channel enable <id>            启用频道",
        "/channel disable <id>           停用频道",
        "/channel set <id> <key> <value> 修改本地配置字段（仅 --spawn 模式）",
        "/channel add-qq-official <id> ... 新增本地 QQ 官方频道（仅 --spawn 模式）",
        "/quit                           退出控制台"
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
    return createElement(ChannelPanel, { config: state.config, channels: state.channels });
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(ChannelPanel, { config: state.config, channels: state.channels }),
    createElement(Box, { marginTop: 1 }, createElement(Text, { bold: true }, "最近日志")),
    createElement(LogPanel, { logs: state.logs.slice(-8), expanded: false })
  );
}

function ChannelPanel({
  config,
  channels
}: {
  readonly config: RuntimeConfig | undefined;
  readonly channels: ConsoleState["channels"];
}) {
  if (channels !== undefined) {
    if (channels.length === 0) {
      return createElement(Text, { color: "gray" }, "暂无频道。");
    }

    return createElement(
      Box,
      { flexDirection: "column" },
      createElement(Text, { bold: true }, "频道"),
      ...channels.map((channel) => {
        const state = channel.status?.state ?? "-";
        const detail = channel.status?.detail === undefined ? "" : `  ${channel.status.detail}`;
        return createElement(
          Text,
          { key: channel.id, color: channel.enabled ? statusColor(state) : "gray" },
          `${channel.id.padEnd(18)} ${formatEnabled(channel.enabled).padEnd(6)} ${channel.adapter.padEnd(12)} ${state.padEnd(8)} ${channel.provider ?? "-"}${detail}`
        );
      })
    );
  }

  const localChannels = Object.entries(config?.channels ?? {});

  if (localChannels.length === 0) {
    return createElement(Text, { color: "gray" }, "暂无频道。");
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { bold: true }, "频道"),
    ...localChannels.map(([channelId, channel]) => {
      const mode = channel.adapter === "qq-official" ? channel.mode : channel.transport;
      const target = channel.adapter === "qq-official" ? (channel.webhookPath ?? "-") : channel.endpoint;
      return createElement(
        Text,
        { key: channelId, color: channel.enabled ? "green" : "gray" },
        `${channelId.padEnd(18)} ${formatEnabled(channel.enabled).padEnd(6)} ${channel.adapter.padEnd(12)} ${mode} ${target}`
      );
    })
  );
}

function LogPanel({ logs, expanded }: { readonly logs: readonly ConsoleLogEntry[]; readonly expanded: boolean }) {
  const visible = expanded ? logs.slice(-20) : logs;

  if (visible.length === 0) {
    return createElement(Text, { color: "gray" }, "暂无日志。");
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
    return createElement(Text, { color: "gray" }, "配置未加载。");
  }

  const redacted = redactConfig(config);
  const lines = JSON.stringify(redacted, null, 2).split("\n").slice(0, 24);

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, { bold: true }, "运行配置"),
    ...lines.map((line, index) => createElement(Text, { key: index }, line)),
    createElement(Text, { color: "gray" }, "仅显示前 24 行，敏感字段已脱敏。")
  );
}

function formatStatus(status: ConsoleState["status"]): string {
  return {
    idle: "空闲",
    starting: "连接中",
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    failed: "失败"
  }[status];
}

function formatView(view: ConsoleState["view"]): string {
  return {
    overview: "总览",
    logs: "日志",
    config: "配置",
    channels: "频道",
    help: "帮助"
  }[view];
}

function formatEnabled(enabled: boolean): string {
  return enabled ? "启用" : "停用";
}

function statusColor(status: string): "gray" | "blue" | "yellow" | "red" | "green" {
  if (status === "online") {
    return "green";
  }

  if (status === "disabled") {
    return "gray";
  }

  if (status === "offline") {
    return "yellow";
  }

  return "blue";
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

import { redactConfig } from "@synapse/runtime-config";
import { Box, Text, useApp, useInput } from "ink";
import { createElement, useEffect, useMemo, useState, type ReactElement } from "react";
import type { RuntimeConsoleController } from "./controller.js";
import { toStructuredLog } from "./log-view-model.js";
import type { ConsoleLevel, ConsoleLogEntry, ConsoleState } from "./types.js";

/** 渲染连接 Runtime 的终端界面 */
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
  const logLevel = state.logLevel ?? "unknown";

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
        "/channel set <id> <key> <value> 修改服务端配置字段，/reload 生效",
        "/channel add-qq-official <id> ... 新增服务端 QQ 官方频道，/reload 生效",
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
    return createElement(ChannelPanel, { channels: state.channels });
  }

  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(ChannelPanel, { channels: state.channels }),
    createElement(Box, { marginTop: 1 }, createElement(Text, { bold: true }, "最近日志")),
    createElement(LogPanel, { logs: state.logs.slice(-8), expanded: false })
  );
}

function ChannelPanel({ channels }: { readonly channels: ConsoleState["channels"] }) {
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

  return createElement(Text, { color: "gray" }, "频道尚未加载。");
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
      const structured = toStructuredLog(entry);
      return createElement(
        Box,
        { key: entry.id, flexDirection: "column" },
        createElement(
          Text,
          { color: statusColorForLog(structured.status, structured.level) },
          `${formatTime(structured.timestamp)} ${formatKind(structured.kind).padEnd(8)} ${formatLogStatus(structured.status).padEnd(8)} ${structured.title}${structured.summary.length === 0 ? "" : `  ${structured.summary}`}`
        ),
        ...(expanded
          ? structured.fields
              .slice(3)
              .map((item) =>
                createElement(
                  Text,
                  { key: `${entry.id}-${item.label}`, color: "gray" },
                  `  ${item.label.padEnd(10)} ${item.value}`
                )
              )
          : [])
      );
    })
  );
}

function ConfigPanel({ config }: { readonly config: ConsoleState["config"] }) {
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

function formatKind(kind: ReturnType<typeof toStructuredLog>["kind"]): string {
  return {
    admin: "admin",
    agent: "agent",
    channel: "channel",
    console: "console",
    event: "event",
    routing: "routing",
    server: "server",
    unknown: "log"
  }[kind];
}

function formatLogStatus(status: ReturnType<typeof toStructuredLog>["status"]): string {
  return {
    accepted: "accepted",
    failed: "failed",
    ignored: "ignored",
    info: "info",
    received: "received",
    started: "started",
    succeeded: "ok"
  }[status];
}

function statusColorForLog(
  status: ReturnType<typeof toStructuredLog>["status"],
  level: ConsoleLevel
): "gray" | "blue" | "yellow" | "red" | "green" {
  if (status === "failed" || level === "error") {
    return "red";
  }

  if (status === "ignored" || level === "warn") {
    return "yellow";
  }

  if (status === "succeeded" || status === "accepted") {
    return "green";
  }

  return levelColor(level);
}

import type { ChannelTarget } from "@synapse/runtime-channel";
import type { MessageSegment, SynapseMessage } from "@synapse/runtime-protocol";
import { isRecord, stringFromUnknown } from "./utils.js";

export function renderOneBot11Message(message: SynapseMessage): string {
  const rendered = message.segments.map(renderSegment).join("");

  if (rendered.length === 0) {
    throw new Error("OneBot 11 adapter can only send messages with text-compatible content in this MVP.");
  }

  return rendered;
}

export function createOneBot11SendParams(
  target: ChannelTarget,
  message: SynapseMessage
): Readonly<Record<string, unknown>> {
  const rendered = renderOneBot11Message(message);

  if (target.type === "private") {
    return {
      message_type: "private",
      user_id: target.userId,
      message: rendered,
      auto_escape: false
    };
  }

  if (target.type === "group") {
    return {
      message_type: "group",
      group_id: target.groupId,
      message: rendered,
      auto_escape: false
    };
  }

  throw new Error("OneBot 11 adapter does not support channel targets.");
}

export function oneBot11SegmentsToSynapseSegments(value: unknown, fallbackRawMessage?: string): readonly MessageSegment[] {
  if (Array.isArray(value)) {
    const segments = value.flatMap((segment) => oneBot11SegmentToSynapseSegments(segment));
    return segments.length > 0 ? mergeAdjacentTextSegments(segments) : fallbackTextSegment(fallbackRawMessage);
  }

  if (typeof value === "string" && value.length > 0) {
    return parseCqMessage(value);
  }

  return fallbackTextSegment(fallbackRawMessage);
}

function renderSegment(segment: SynapseMessage["segments"][number]): string {
  if (segment.type === "text") {
    return segment.text;
  }

  if (segment.type === "mention") {
    return segment.userId === undefined ? "" : `[CQ:at,qq=${escapeCqValue(segment.userId)}]`;
  }

  if (segment.type === "reply") {
    return segment.messageId === undefined ? "" : `[CQ:reply,id=${escapeCqValue(segment.messageId)}]`;
  }

  if (segment.type === "image") {
    const file = segment.url ?? segment.fileId ?? segment.localPath;
    return file === undefined ? "" : `[CQ:image,file=${escapeCqValue(file)}]`;
  }

  return "";
}

function oneBot11SegmentToSynapseSegments(segment: unknown): readonly MessageSegment[] {
  if (typeof segment === "string") {
    return [{ type: "text", text: segment }];
  }

  if (!isRecord(segment)) {
    return [];
  }

  const type = stringFromUnknown(segment.type);
  const data = isRecord(segment.data) ? segment.data : {};

  if (type === "text") {
    return [{ type: "text", text: stringFromUnknown(data.text) ?? "" }];
  }

  if (type === "at") {
    const userId = stringFromUnknown(data.qq);
    if (userId === "all") {
      return [{ type: "mention", target: "all" }];
    }

    return [{ type: "mention", target: userId === undefined ? "unknown" : "user", ...(userId === undefined ? {} : { userId }) }];
  }

  if (type === "reply") {
    const messageId = stringFromUnknown(data.id);
    return [{ type: "reply", ...(messageId === undefined ? {} : { messageId }) }];
  }

  if (type === "image") {
    const url = stringFromUnknown(data.url);
    const fileId = stringFromUnknown(data.file);
    return [
      {
        type: "image",
        ...(url === undefined ? {} : { url }),
        ...(fileId === undefined ? {} : { fileId })
      }
    ];
  }

  return [];
}

function parseCqMessage(message: string): readonly MessageSegment[] {
  const segments: MessageSegment[] = [];
  const pattern = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;

  for (const match of message.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "text", text: unescapeCqText(message.slice(lastIndex, index)) });
    }

    const type = match[1] ?? "";
    const params = parseCqParams(match[2] ?? "");
    if (type === "at") {
      const userId = params.qq;
      if (userId === "all") {
        segments.push({ type: "mention", target: "all" });
      } else {
        segments.push({ type: "mention", target: userId === undefined ? "unknown" : "user", ...(userId === undefined ? {} : { userId }) });
      }
    } else if (type === "reply") {
      segments.push({ type: "reply", ...(params.id === undefined ? {} : { messageId: params.id }) });
    } else if (type === "image") {
      segments.push({
        type: "image",
        ...(params.url === undefined ? {} : { url: params.url }),
        ...(params.file === undefined ? {} : { fileId: params.file })
      });
    } else {
      segments.push({ type: "text", text: match[0] ?? "" });
    }

    lastIndex = index + (match[0]?.length ?? 0);
  }

  if (lastIndex < message.length) {
    segments.push({ type: "text", text: unescapeCqText(message.slice(lastIndex)) });
  }

  return mergeAdjacentTextSegments(segments.length > 0 ? segments : [{ type: "text", text: message }]);
}

function parseCqParams(source: string): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  const normalized = source.startsWith(",") ? source.slice(1) : source;

  for (const entry of normalized.split(",")) {
    if (entry.length === 0) {
      continue;
    }

    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    params[entry.slice(0, separatorIndex)] = unescapeCqValue(entry.slice(separatorIndex + 1));
  }

  return params;
}

function fallbackTextSegment(text: string | undefined): readonly MessageSegment[] {
  return [{ type: "text", text: text ?? "" }];
}

function mergeAdjacentTextSegments(segments: readonly MessageSegment[]): readonly MessageSegment[] {
  const merged: MessageSegment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.type === "text" && previous?.type === "text") {
      merged[merged.length - 1] = { type: "text", text: previous.text + segment.text };
    } else {
      merged.push(segment);
    }
  }

  return merged;
}

function escapeCqValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll(",", "&#44;");
}

function unescapeCqValue(value: string): string {
  return unescapeCqText(value).replaceAll("&#44;", ",");
}

function unescapeCqText(value: string): string {
  return value.replaceAll("&#91;", "[").replaceAll("&#93;", "]").replaceAll("&amp;", "&");
}

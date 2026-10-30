import type {
  ChannelActionTarget,
  ChannelCapability,
  ChannelOperationResult,
  GroupFileUpload,
  SynapseMessage
} from "@synapse/runtime-protocol";
import type { ChannelFileResourceAction, ChannelFileRef } from "@synapse/runtime-protocol";
import type { OneBot11Api } from "./api.js";
import { isOneBot11Success } from "./codec.js";
import type { OneBot11Connection } from "./transport.js";
import { isRecord, stringFromUnknown } from "./utils.js";

/** NapCat 群文件上限，与执行前能力约束共用，避免声明和实际校验漂移 */
export const NAPCAT_MAX_GROUP_FILE_BYTES = 10_485_760;

/** NapCat 文件扩展，标准 OneBot11 提供方不实例化此对象 */
export class NapCatApi {
  constructor(private readonly connection: OneBot11Connection) {}

  /** 查询扩展只暴露平台文件事实，下载地址由使用方即时校验且不得持久化 */
  async readFiles(action: ChannelFileResourceAction): Promise<ChannelOperationResult> {
    if (action.target.type !== "group" || action.actionType === "file.delete")
      return { status: "unsupported", error: "Only group file reads are implemented" };
    const group_id = action.target.groupId;
    try {
      if (action.actionType === "file.get") {
        const response = await this.connection.call("get_group_file_url", {
          group_id,
          file_id: action.fileId,
          ...(action.busid ? { busid: action.busid } : {})
        });
        const url = isRecord(response.data) ? stringFromUnknown(response.data.url) : undefined;
        if (!isOneBot11Success(response) || !url) return { status: "failed", error: "remote_file_unavailable" };
        return { status: "succeeded", data: { kind: "file", file: { id: action.fileId, name: action.fileId, url } } };
      }
      const folderId = "folderId" in action ? action.folderId : undefined;
      const response = await this.connection.call(folderId ? "get_group_files_by_folder" : "get_group_root_files", {
        group_id,
        ...(folderId ? { folder_id: folderId } : {})
      });
      if (!isOneBot11Success(response) || !isRecord(response.data) || !Array.isArray(response.data.files))
        return { status: "failed", error: "remote_file_list_failed" };
      const items: ChannelFileRef[] = response.data.files.filter(isRecord).flatMap((file) => {
        const id = stringFromUnknown(file.file_id);
        const name = stringFromUnknown(file.file_name);
        if (!id || !name) return [];
        return [
          {
            id,
            name,
            ...(typeof file.file_size === "number" ? { sizeBytes: file.file_size } : {}),
            extensions: { ...(file.busid === undefined ? {} : { busid: String(file.busid) }) }
          }
        ];
      });
      return { status: "succeeded", data: { kind: "files", items } };
    } catch {
      return { status: "failed", error: "remote_file_read_failed" };
    }
  }

  /** 私聊与群文件共享原生上传动作，具体 API 仍明确标记为 NapCat 扩展 */
  getFileCapability(): ChannelCapability {
    return {
      status: "partially-supported",
      source: "documented",
      implementation: "napcat:file.upload",
      constraints: { targetTypes: ["private", "group"], maxFileSizeBytes: NAPCAT_MAX_GROUP_FILE_BYTES },
      reason: "按目标映射 upload_private_file 或 upload_group_file，不等于发送媒体消息"
    };
  }

  /** 声明统一上传语义的扩展实现来源 */
  getGroupFileCapability(): ChannelCapability {
    return {
      status: "supported",
      implementation: "napcat:upload_group_file",
      constraints: { targetTypes: ["group"], maxFileSizeBytes: NAPCAT_MAX_GROUP_FILE_BYTES }
    };
  }

  /** 先上传附件再委托标准消息 API，部分交付后的任何失败都不能自动重试 */
  async sendMessage(
    target: ChannelActionTarget,
    message: SynapseMessage,
    standard: OneBot11Api
  ): Promise<ChannelOperationResult> {
    const files = message.segments.filter((part) => part.type === "file");
    if (files.length === 0) return standard.sendMessage(target, message);
    if (target.type === "channel")
      return { status: "unsupported", error: "NapCat file uploads require a private or group target." };
    if (files.some((file) => file.url === undefined))
      return { status: "failed", error: "NapCat file uploads require a file URL or base64 resource." };
    let delivered = false;
    for (const file of files) {
      // 附件顺序与部分交付事实决定重试安全性，不能并行上传
      // oxlint-disable-next-line no-await-in-loop
      const receipt = await this.#upload(target, file.name, file.url!);
      if (receipt.status !== "succeeded") {
        if (!delivered && receipt.status === "failed") return receipt;
        return { status: "uncertain", error: "文件上传回执未确认，请核对文件后再决定是否重新发送" };
      }
      delivered = true;
    }
    const remaining = message.segments.filter((part) => part.type !== "file");
    if (!remaining.some((part) => part.type === "image" || (part.type === "text" && part.text.length > 0)))
      return { status: "succeeded" };
    const receipt = await standard.sendMessage(target, { ...message, segments: remaining });
    return receipt.status === "succeeded"
      ? receipt
      : { status: "uncertain", error: "附件已上传，说明消息回执未确认，请核对后再决定是否重新发送" };
  }

  /** 使用内容传输群文件，不能假设远端 NapCat 可以读取 Runtime 的宿主路径 */
  async uploadGroupFile(groupId: string, file: GroupFileUpload): Promise<ChannelOperationResult> {
    return this.uploadFile({ type: "group", groupId }, file);
  }

  /** 上传原生字节内容，禁止通过路径假定远端可访问 Runtime 文件系统 */
  async uploadFile(target: ChannelActionTarget, file: GroupFileUpload): Promise<ChannelOperationResult> {
    if (target.type === "channel")
      return { status: "unsupported", error: "NapCat file upload requires a private or group target." };
    if (
      !/^\d+$/.test(target.type === "group" ? target.groupId : target.userId) ||
      file.name.length === 0 ||
      file.name.length > 120 ||
      /[\\/:]/.test(file.name) ||
      [...file.name].some((c) => c.charCodeAt(0) < 32)
    ) {
      return { status: "failed", error: "群标识或文件名无效" };
    }
    if (file.data.byteLength === 0 || file.data.byteLength > NAPCAT_MAX_GROUP_FILE_BYTES)
      return { status: "failed", error: "群文件必须介于 1 字节和 10 MiB 之间" };
    return this.#upload(target, file.name, `base64://${Buffer.from(file.data).toString("base64")}`);
  }

  async #upload(
    target: Exclude<ChannelActionTarget, { type: "channel" }>,
    name: string,
    resource: string
  ): Promise<ChannelOperationResult> {
    const action = target.type === "group" ? "upload_group_file" : "upload_private_file";
    try {
      const response = await this.connection.call(action, {
        ...(target.type === "group" ? { group_id: target.groupId } : { user_id: target.userId }),
        file: resource,
        name,
        upload_file: true
      });
      // 平台错误文本可能回显上传内容，只保留动作名与错误码
      if (response.status === "failed")
        return {
          status: "failed",
          error: `NapCat ${action}: upload failed (retcode ${response.retcode ?? "unknown"})`
        };
      if (!isOneBot11Success(response)) return { status: "uncertain", error: "文件上传未返回明确终态，请先核对群文件" };
      const fileId = isRecord(response.data) ? stringFromUnknown(response.data.file_id) : undefined;
      return { status: "succeeded", ...(fileId === undefined ? {} : { fileId }) };
    } catch {
      // 外部异常可能包含 base64 内容，未知结果只返回可安全持久化的固定文案
      return { status: "uncertain", error: "文件上传回执未确认，请核对文件后再决定是否重新发送" };
    }
  }
}

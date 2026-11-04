import type { Nova, NovaRequest, NovaResponse } from "nova-http";
import type { LoadConfigOptions, RuntimeConfig } from "../../config/index.js";
import { ConfigEditError, readConfigEditor, saveConfigEditor } from "../../config/editor.js";
import { readJsonBody, sendJson } from "../http.js";

/** 在统一管理认证之后注册文件配置接口，保存和应用配置保持独立 */
export function registerConfigRoutes(deps: {
  readonly app: Nova;
  readonly getConfig: () => RuntimeConfig;
  readonly getConfigPath: () => string | undefined;
  readonly configLoadOptions?: LoadConfigOptions | undefined;
}): void {
  for (const method of ["get", "patch"] as const) {
    deps.app[method](
      method === "get" ? "/admin/config/editor" : "/admin/config",
      async (request: NovaRequest, response: NovaResponse) => {
        const path = deps.getConfigPath();
        if (!path) {
          sendJson(response, 409, {
            ok: false,
            error: "config_path_not_available",
            message: "当前 Runtime 未从配置文件启动，无法保存设置"
          });
          return;
        }
        try {
          const result =
            method === "get"
              ? await readConfigEditor(path, deps.getConfig(), deps.configLoadOptions)
              : await saveConfigEditor(path, readJsonBody(request), deps.getConfig(), deps.configLoadOptions);
          sendJson(response, 200, result);
        } catch (error) {
          const code = error instanceof ConfigEditError ? error.code : "config_file_unavailable";
          const messages = {
            config_conflict: "配置文件已被其他操作修改，请重新读取后再编辑",
            invalid_config: "配置校验失败，请检查必填项、字段范围和关联配置",
            invalid_config_changes: "配置修改格式无效，请检查选项后重试",
            config_file_unavailable: "无法读取或保存配置文件，请检查文件权限和格式"
          };
          sendJson(response, code === "config_conflict" ? 409 : code === "config_file_unavailable" ? 500 : 400, {
            ok: false,
            error: code,
            message: messages[code],
            ...(error instanceof ConfigEditError ? { fields: error.fields } : {})
          });
        }
      }
    );
  }
}

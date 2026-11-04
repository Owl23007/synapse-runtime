import "./settings.css";
import { useCallback, useEffect, useState } from "react";
import type { ConfigEditorSnapshot, ConfigFileChange, RuntimeAdminClient } from "@synapse/runtime-client";
import { useLoad } from "../../shared/hooks/use-load.js";
import { ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { message } from "../../shared/lib/runtime.js";
import { toast } from "../../shared/lib/toast.js";
import { ConfigField } from "./config-field.js";
import { changeConfigDraft, CONFIG_SECTIONS } from "./settings-model.js";

/** 按深链接定位配置分类，编辑草稿在分类跳转时保留，保存后提示重载或重启边界 */
export function ConfigSettings({
  client,
  initialSection = "runtime",
  onApplied
}: {
  client: RuntimeAdminClient;
  initialSection?: string;
  onApplied: () => void;
}) {
  const load = useCallback(() => client.configEditor(), [client]);
  const data = useLoad(load);
  return (
    <section className="panel padded config-settings">
      <h2>应用配置</h2>
      <p>按选项修改服务端配置文件，保存后应用更改。环境变量、用户配置和命令行覆盖仍优先生效</p>
      <ErrorNotice error={data.error} retry={data.reload} />
      {data.loading ? (
        <Loading />
      ) : (
        data.value && (
          <SettingsForm
            key={data.value.revision}
            snapshot={data.value}
            client={client}
            initialSection={initialSection}
            refresh={data.reload}
            onApplied={onApplied}
          />
        )
      )}
    </section>
  );
}

function SettingsForm({
  snapshot,
  client,
  initialSection,
  refresh,
  onApplied
}: {
  snapshot: ConfigEditorSnapshot;
  client: RuntimeAdminClient;
  initialSection: string;
  refresh: () => void;
  onApplied: () => void;
}) {
  const [section, setSection] = useState(() =>
    Object.hasOwn(snapshot.schema.properties ?? {}, initialSection) ? initialSection : "runtime"
  );
  const [draft, setDraft] = useState(snapshot.config);
  const [changes, setChanges] = useState<readonly ConfigFileChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [restart, setRestart] = useState(snapshot.restartFields);
  const [applied, setApplied] = useState(false);
  const groups = Object.entries(snapshot.schema.properties ?? {});
  const group = groups.find(([key]) => key === section);
  useEffect(() => {
    setSection(Object.hasOwn(snapshot.schema.properties ?? {}, initialSection) ? initialSection : "runtime");
  }, [initialSection, snapshot.schema]);
  const fieldSchema =
    section === "agent" && group
      ? {
          ...group[1],
          properties: {
            ...group[1].properties,
            default: {
              ...group[1].properties?.default,
              enum: Object.keys((draft.agent as { providers?: object } | undefined)?.providers ?? {})
            }
          }
        }
      : group?.[1];

  useEffect(() => {
    if (!changes.length || saved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes.length, saved]);

  const change = (operation: ConfigFileChange) => {
    setDraft((previous) => changeConfigDraft(previous, operation));
    setChanges((previous) => [...previous, operation]);
    setError("");
  };
  return (
    <>
      <div className="config-layout">
        <nav className="config-navigation" aria-label="配置分类">
          {groups.map(([key]) => (
            <button
              key={key}
              type="button"
              aria-current={section === key ? "true" : undefined}
              onClick={() => setSection(key)}
            >
              {CONFIG_SECTIONS[key]?.[0] ?? key}
            </button>
          ))}
        </nav>
        <form
          className="config-form"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void client
              .saveConfig(snapshot.revision, changes)
              .then((result) => {
                setRestart(result.restartFields);
                setSaved(true);
                toast.success("配置已保存到文件");
                return undefined;
              })
              .catch((cause: unknown) => setError(message(cause)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="config-section-heading">
            <h3>{CONFIG_SECTIONS[section]?.[0] ?? section}</h3>
            <p>{CONFIG_SECTIONS[section]?.[1]}</p>
          </div>
          <fieldset disabled={busy || saved}>
            {fieldSchema && (
              <ConfigField
                key={section}
                schema={fieldSchema}
                value={draft[section]}
                path={[section]}
                onChange={change}
                expanded
              />
            )}
          </fieldset>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {saved ? (
            <div className="config-result" role="status">
              <strong>{applied ? "配置已应用" : "配置已保存到文件"}</strong>
              {!applied &&
                (restart.length ? (
                  <p>以下设置需要重启 Runtime 后生效：{restart.join("、")}</p>
                ) : (
                  <p>点击“应用配置”重新加载，运行中的任务可能会中断</p>
                ))}
              <div className="config-actions">
                {!restart.length && !applied && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      void client
                        .reload()
                        .then(() => {
                          setApplied(true);
                          onApplied();
                          toast.success("配置已应用");
                          return undefined;
                        })
                        .catch((cause: unknown) => setError(`文件已保存，应用失败：${message(cause)}`))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {busy ? "正在应用…" : "应用配置"}
                  </button>
                )}
                <button type="button" disabled={busy} onClick={refresh}>
                  继续编辑
                </button>
              </div>
            </div>
          ) : (
            <div className="config-footer">
              <small>
                {changes.length
                  ? `有 ${changes.length} 项待保存修改`
                  : "密钥输入新值后替换，未修改时保留原值；移除选项后使用默认或继承值"}
              </small>
              <div className="config-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(snapshot.config);
                    setChanges([]);
                    setError("");
                    refresh();
                  }}
                >
                  重新读取
                </button>
                <button type="submit" className="primary" disabled={busy || !changes.length}>
                  {busy ? "正在保存…" : "保存配置"}
                </button>
              </div>
            </div>
          )}
          {!saved && restart.length > 0 && (
            <p className="config-restart">文件中有尚未应用的重启设置：{restart.join("、")}</p>
          )}
        </form>
      </div>
    </>
  );
}

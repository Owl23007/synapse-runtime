import { useCallback, useState } from "react";
import type { AssetInfo, RuntimeAdminClient } from "@synapse/runtime-client";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { Icon } from "../../../shared/ui/icons.js";
import { navigateTabs } from "../../../shared/ui/tabs.js";

type PickerProps = {
  client: RuntimeAdminClient;
  workspaceId: string;
  disabled: boolean;
  isSelected: (asset: AssetInfo) => boolean;
  onAdd: (asset: AssetInfo) => void;
};

/** 先选择文件所属工作区，再显式附加或复制，避免混淆文件的来源与去向 */
export function WorkspaceFilePicker(props: PickerProps) {
  const [scope, setScope] = useState("current");
  const [other, setOther] = useState("");
  const workspaces = useLoad(useCallback(() => props.client.resourceWorkspaces(), [props.client]));
  const others = workspaces.value?.items.filter((item) => item.id !== props.workspaceId) ?? [];
  const selected = scope === "current" ? props.workspaceId : other || others[0]?.id || "";
  return (
    <>
      <div className="composer-file-scopes" role="tablist" aria-label="文件所属工作区" onKeyDown={navigateTabs}>
        {[
          ["current", "当前工作区"],
          ["other", "其他工作区"]
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            tabIndex={scope === value ? 0 : -1}
            disabled={props.disabled}
            onClick={() => setScope(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      {scope === "other" && (
        <>
          <ErrorNotice error={workspaces.error} retry={workspaces.reload} />
          {workspaces.loading ? (
            <Loading />
          ) : others.length > 0 ? (
            <label className="composer-workspace-select">
              来源工作区
              <select value={selected} disabled={props.disabled} onChange={(event) => setOther(event.target.value)}>
                {others.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            !workspaces.error && <p className="composer-files-empty">暂无其他工作区</p>
          )}
        </>
      )}
      {selected && (
        <>
          <WorkspaceFileList key={selected} {...props} sourceWorkspaceId={selected} />
        </>
      )}
    </>
  );
}

function WorkspaceFileList({
  client,
  workspaceId,
  sourceWorkspaceId,
  disabled,
  isSelected,
  onAdd
}: PickerProps & {
  sourceWorkspaceId: string;
}) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [older, setOlder] = useState<readonly AssetInfo[]>([]);
  const files = useLoad(
    useCallback(
      () => client.assets(sourceWorkspaceId, { q, ...(cursor ? { cursor } : {}) }),
      [client, sourceWorkspaceId, q, cursor]
    )
  );
  const items = [...new Map([...older, ...(files.value?.items ?? [])].map((asset) => [asset.id, asset])).values()];
  const copying = sourceWorkspaceId !== workspaceId;
  return (
    <>
      <div className="composer-file-search">
        <Icon name="search" />
        <input
          aria-label="搜索工作区文件"
          placeholder="搜索文件名"
          value={q}
          maxLength={500}
          disabled={disabled}
          onChange={(event) => {
            setQ(event.target.value);
            setCursor(undefined);
            setOlder([]);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      <ErrorNotice error={files.error} retry={files.reload} />
      <div className="composer-file-results" aria-label="可附加的文件">
        {files.loading && !items.length ? (
          <Loading />
        ) : !files.error && !items.length ? (
          <p className="composer-files-empty">{q ? "没有匹配的文件" : "该工作区暂无文件"}</p>
        ) : (
          items.map((asset) => {
            const selected = isSelected(asset);
            return (
              <button
                className="composer-file-row"
                type="button"
                key={asset.id}
                aria-pressed={selected}
                disabled={disabled || selected}
                onClick={() => onAdd(asset)}
              >
                <Icon name="file" />
                <span className="composer-file-name">
                  <strong title={asset.displayName}>{asset.displayName}</strong>
                  <small>{asset.currentVersionId ? "已保存的文件" : "将获取文件内容"}</small>
                </span>
                <span className="composer-file-action">
                  {selected ? (
                    <>
                      <Icon name="check" />
                      已附加
                    </>
                  ) : copying ? (
                    "复制并附加"
                  ) : (
                    "附加"
                  )}
                </span>
              </button>
            );
          })
        )}
        {files.value?.nextCursor && (
          <button
            className="composer-files-more"
            type="button"
            disabled={disabled || files.loading}
            onClick={() => {
              setOlder(items);
              setCursor(files.value!.nextCursor);
            }}
          >
            加载更多
          </button>
        )}
      </div>
    </>
  );
}

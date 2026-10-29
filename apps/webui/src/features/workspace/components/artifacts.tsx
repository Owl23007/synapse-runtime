import { useCallback, useState } from "react";
import { Empty, ErrorNotice, Loading } from "../../../shared/ui/feedback.js";
import { message } from "../../../shared/lib/runtime.js";
import { useLoad } from "../../../shared/hooks/use-load.js";
import { type ViewProps } from "../../../shared/types/runtime.js";
import { toast } from "../../../shared/lib/toast.js";

/** 在会话作用域内分页与下载已登记工件 */
export function WorkspaceArtifacts({ client, revision, sessionId }: ViewProps & { sessionId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [older, setOlder] = useState<Record<string, unknown>[]>([]);
  const load = useCallback(() => client.artifacts(sessionId, cursor), [client, sessionId, cursor]);
  const data = useLoad(load, revision);
  const [busy, setBusy] = useState("");
  const artifacts = [
    ...new Map([...older, ...(data.value?.items ?? [])].map((item) => [String(item.id), item])).values()
  ];
  return (
    <div className="artifact-list">
      <ErrorNotice error={data.error} retry={data.reload} />
      {artifacts.map((item) => (
        <div className="artifact-row" key={String(item.id)}>
          <span className="file-icon">▤</span>
          <div>
            <strong>{String(item.name)}</strong>
            <small>
              {String(item.mimeType ?? "文件")} · {Math.ceil(Number(item.size ?? 0) / 1024)} KB
            </small>
          </div>
          {typeof item.runId === "string" && (
            <a className="button" href={`#/runs/${encodeURIComponent(item.runId)}`}>
              关联运行 ↗
            </a>
          )}
          <button
            disabled={!!busy}
            onClick={() => {
              setBusy(String(item.id));
              void client
                .downloadArtifact(sessionId, String(item.id))
                .then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = String(item.name);
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                  toast.success("已开始下载工件");
                  return undefined;
                })
                .catch((cause) => toast.error(message(cause)))
                .finally(() => setBusy(""));
            }}
          >
            {busy === item.id ? "下载中…" : "下载 ↓"}
          </button>
        </div>
      ))}
      {!artifacts.length && (data.loading ? <Loading /> : <Empty title="暂无工件" text="运行生成的文件将显示在这里" />)}
      {data.value?.nextCursor && (
        <button
          onClick={() => {
            setOlder(artifacts);
            setCursor(String(data.value!.nextCursor));
          }}
        >
          加载更多工件
        </button>
      )}
    </div>
  );
}

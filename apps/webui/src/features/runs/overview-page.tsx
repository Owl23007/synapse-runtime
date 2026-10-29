import { useCallback } from "react";
import { ErrorNotice, Loading } from "../../shared/ui/feedback.js";
import { PageTitle } from "../../shared/ui/content.js";
import { useLoad } from "../../shared/hooks/use-load.js";
import { type ViewProps } from "../../shared/types/runtime.js";
import { RunTable } from "./run-table.js";

/** 总览只展示真实运行与检查入口 */
export function Overview({ client, revision }: ViewProps) {
  const load = useCallback(() => client.runs({ limit: 50 }), [client]);
  const data = useLoad(load, revision);
  const runs = data.value?.items ?? [];
  return (
    <>
      <PageTitle title="运行总览" description="" action={<button onClick={data.reload}>刷新</button>} />
      <ErrorNotice error={data.error} retry={data.reload} />
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>最近运行</h2>
          </div>
          <a href="#/runs">全部运行 ↗</a>
        </div>
        {data.loading && !data.value ? <Loading /> : <RunTable runs={runs.slice(0, 8)} />}
      </section>
    </>
  );
}

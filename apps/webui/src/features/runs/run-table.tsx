import { type RunTrace } from "@synapse/runtime-client";
import { time } from "../../shared/lib/runtime.js";
import { Badge, Empty } from "../../shared/ui/feedback.js";

/** 展示运行状态与详情链接，不从日志推断执行结果 */
export function RunTable({ runs }: { runs: readonly RunTrace[] }) {
  return runs.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>请求 / 运行</th>
            <th>状态</th>
            <th>频道</th>
            <th>当前阶段</th>
            <th>开始时间</th>
            <th aria-label="查看" />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <a className="run-link" href={`#/runs/${encodeURIComponent(run.id)}`}>
                  {run.summary || "无文本请求"}
                </a>
                <code className="secondary-id">{run.id.slice(0, 16)}</code>
              </td>
              <td>
                <Badge status={run.status} />
              </td>
              <td>
                <span className="channel-tag">{run.channelId}</span>
              </td>
              <td>{run.phase}</td>
              <td className="nowrap muted">{time(run.startedAt)}</td>
              <td aria-hidden="true">↗</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="暂无运行记录" text="发送消息开始运行，或调整筛选条件" />
  );
}

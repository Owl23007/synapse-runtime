import { type ReactNode } from "react";

/** 页面标题只保留对象名称与主要操作，描述用于必要的对象标识 */
export function PageTitle({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
/** 以文本显示结构化数据，模型内容不会作为 HTML 执行 */
export function Json({ value }: { value: unknown }) {
  return <pre className="json">{value === undefined ? "未记录" : JSON.stringify(value, null, 2)}</pre>;
}

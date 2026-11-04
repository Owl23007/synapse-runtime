import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./icons.js";
import { toast } from "../lib/toast.js";
import { message } from "../lib/runtime.js";
import "./markdown.css";

/** 预览文档禁用脚本、表单和外部资源，模型 HTML 不能访问工作台会话 */
export function previewDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>body{font:14px/1.6 system-ui,sans-serif;margin:16px;overflow-wrap:anywhere}img,svg{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${content}</body></html>`;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [preview, setPreview] = useState(false);
  const canPreview = ["html", "svg", "markdown", "md"].includes(language);
  return (
    <div className="message-code-block">
      <div className="code-block-toolbar">
        <span>{language || "代码"}</span>
        {canPreview && (
          <button type="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            <Icon name={preview ? "file" : "eye"} />
            {preview ? "源码" : "预览"}
          </button>
        )}
        <button
          type="button"
          title="复制代码"
          aria-label="复制代码"
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => toast.success("已复制代码"))
              .catch((cause) => toast.error(message(cause)));
          }}
        >
          <Icon name="copy" />
          <span>复制</span>
        </button>
      </div>
      {preview ? (
        language === "md" || language === "markdown" ? (
          <div className="markdown-block-preview">
            <Markdown text={code} previews={false} />
          </div>
        ) : (
          <iframe
            title={`${language.toUpperCase()} 内容预览`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={previewDocument(code)}
          />
        )
      ) : (
        <pre>
          <code className={language ? `language-${language}` : undefined}>{code}</code>
        </pre>
      )}
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => {
    const code = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(code)) return <pre>{children}</pre>;
    return (
      <CodeBlock
        code={String(code.props.children ?? "").replace(/\n$/, "")}
        language={/language-([\w-]+)/.exec(code.props.className ?? "")?.[1]?.toLowerCase() ?? ""}
      />
    );
  },
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  )
};
const plainComponents: Components = { ...components, pre: ({ children }) => <pre>{children}</pre> };

/** 按实际到达的文本增量重渲染 Markdown，默认过滤原始 HTML 和危险链接 */
export function Markdown({ text, previews = true }: { text: string; previews?: boolean }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={previews ? components : plainComponents} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}

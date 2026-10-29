import * as React from "react";
import { createRoot } from "react-dom/client";
import { MaterialProvider, MaterialSettings, Surface } from "/src/shared/ui/surface.tsx";
import { Badge, Empty, ErrorNotice, Loading } from "/src/shared/ui/feedback.tsx";
import "/node_modules/@fontsource/inter/latin-400.css";
import "/node_modules/@fontsource/inter/latin-500.css";
import "/node_modules/@fontsource/inter/latin-600.css";
import "/src/styles/index.css";
import "/@webui-test-fixture.css";
const { useState } = React;

// 独立开发预览不进入生产入口，不携带凭据或伪造 Runtime 数据
function DesignSystem() {
  const [zoom, setZoom] = useState(100);
  return (
    <MaterialProvider>
      <main className="specimen">
        <header className="page-title">
          <h1>设计系统</h1>
          <MaterialSettings />
        </header>
        <div className="specimen-materials">
          {(["standard", "frosted", "liquid"] as const).map((material, index) => (
            <section key={material}>
              <h2>{["标准卡片", "毛玻璃浮层", "液态工具栏"][index]}</h2>
              <div className="specimen-stage">
                <div className="specimen-backdrop" aria-hidden="true">
                  <span>主线</span>
                  <span>产品发布计划</span>
                  <span>体验优化方案</span>
                </div>
                <Surface material={material} className="specimen-card">
                  {material === "standard" ? (
                    <>
                      <h3>执行结果</h3>
                      <p>产品发布计划</p>
                      <Badge status="succeeded" />
                    </>
                  ) : material === "frosted" ? (
                    <>
                      <h3>快捷操作</h3>
                      <button className="full" onClick={() => setZoom(100)}>
                        适应画布
                      </button>
                      <button className="full" onClick={() => setZoom(100)}>
                        重置缩放
                      </button>
                    </>
                  ) : (
                    <>
                      <h3>画布操作</h3>
                      <div className="toolbar-actions">
                        <button aria-label="缩小" onClick={() => setZoom(Math.max(20, zoom - 10))}>
                          −
                        </button>
                        <output>{zoom}%</output>
                        <button aria-label="放大" onClick={() => setZoom(Math.min(180, zoom + 10))}>
                          ＋
                        </button>
                      </div>
                      <small>上下文 DAG</small>
                    </>
                  )}
                </Surface>
              </div>
            </section>
          ))}
        </div>
        <section className="specimen-controls">
          <h2>控件与状态</h2>
          <div className="record-actions">
            <button className="primary">发送消息 ↑</button>
            <button>刷新</button>
            <button disabled>执行中…</button>
            <Badge status="running" />
            <Badge status="failed" />
            <Badge status="blocked" />
          </div>
          <label>
            会话名称
            <input defaultValue="产品发布计划" />
          </label>
          <ErrorNotice error="连接中断" retry={() => {}} />
          <Loading />
          <Empty title="暂无工件" text="" />
        </section>
      </main>
    </MaterialProvider>
  );
}

createRoot(document.getElementById("root")!).render(<DesignSystem />);

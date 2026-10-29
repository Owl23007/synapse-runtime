import { Component, type ReactNode } from "react";

/** 页面或异步模块失败时保留导航，并提供由用户触发的重新载入入口 */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  /** 渲染异常仅切换页面反馈，不自动重放运行或持久化凭据 */
  static getDerivedStateFromError() {
    return { failed: true };
  }

  /** 将错误限制在内容区域，刷新后仍沿用正常连接流程 */
  render() {
    return this.state.failed ? (
      <div className="notice error" role="alert">
        <span>页面加载失败</span>
        <button onClick={() => location.reload()}>重新载入</button>
      </div>
    ) : (
      this.props.children
    );
  }
}

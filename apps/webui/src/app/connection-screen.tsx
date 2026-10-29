import { useState, type FormEvent } from "react";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { normalizeEndpoint, record, message } from "../shared/lib/runtime.js";
import { ErrorNotice } from "../shared/ui/feedback.js";

/** 建立同源 Runtime 连接，凭据仅交给应用内存保存 */
export function ConnectionScreen({ onConnect }: { onConnect: (client: RuntimeAdminClient, endpoint: string) => void }) {
  const [endpoint, setEndpoint] = useState(location.origin);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const normalized = normalizeEndpoint(endpoint);
      if (normalized !== location.origin) throw new Error("请先在浏览器中打开目标 Runtime 的管理地址，再连接该服务");
      const client = new RuntimeAdminClient({ endpoint: normalized, ...(token ? { token } : {}) });
      const status = record(await client.status());
      if (status.protocolVersion !== 1) throw new Error("服务协议版本不兼容，请更新 WebUI 与 Runtime 到同一版本");
      onConnect(client, normalized);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connect-page">
      <div className="connect-form">
        <form onSubmit={submit}>
          <a href="#/" className="brand">
            <span className="brand-icon">S</span>
            <span>
              Synapse<small>Runtime</small>
            </span>
          </a>
          <h2>连接 Runtime</h2>
          <label>
            服务地址
            <input
              required
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            访问令牌 <span className="muted">可选</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              placeholder="输入 Admin Token"
            />
          </label>
          <p className="hint"></p>
          {error && <ErrorNotice error={error} />}
          <button className="primary full" disabled={busy}>
            {busy ? "正在连接…" : "连接工作空间 →"}
          </button>
        </form>
      </div>
    </div>
  );
}

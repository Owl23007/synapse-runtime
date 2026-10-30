import { onTestFinished } from "vitest";
import { RuntimeAdminClient } from "@synapse/runtime-client";
import { RuntimeServer } from "../../src/server/runtime-server.js";

/** 启动仅供当前用例使用的管理服务，在启动失败与断言失败时同样停止服务 */
export async function createAdminServerFixture(config: ConstructorParameters<typeof RuntimeServer>[0]["config"]) {
  const server = new RuntimeServer({ config, logger: { info() {}, warn() {}, error() {} } });
  onTestFinished(() => server.stop());
  const listening = await server.start();
  const endpoint = `http://127.0.0.1:${listening.admin!.port}`;
  const client = new RuntimeAdminClient({ endpoint, ...(config.admin.token ? { token: config.admin.token } : {}) });
  return { server, endpoint, client };
}

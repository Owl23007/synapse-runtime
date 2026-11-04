import type { RunEvent } from "@synapse/runtime-client";
import { record } from "../../../shared/lib/runtime.js";

/** 只显示当前模型步骤的最新快照，重试和工具后的新步骤不会拼接旧正文 */
export function streamedReply(events: readonly RunEvent[]): string {
  let content = "";
  let call = "";
  let attempt: string | undefined;
  for (const event of events) {
    const data = record(event.data);
    if (event.type === "run_started" || event.type === "run_resumed") {
      content = "";
      call = "";
      attempt = event.attemptId;
    }
    if (event.type === "model_call_started") {
      call = String(data.modelCallId ?? "");
      attempt = event.attemptId;
      content = "";
    } else if (
      (event.type === "model_output" || event.type === "model_call_succeeded") &&
      event.attemptId === attempt &&
      String(data.modelCallId ?? "") === call &&
      typeof data.content === "string"
    ) {
      content = data.content;
    }
  }
  return content;
}

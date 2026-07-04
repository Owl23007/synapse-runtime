import { createPrivateKey, sign } from "node:crypto";
import type { QqOfficialWebhookValidationRequest, QqOfficialWebhookValidationResponse } from "./types.js";
import { repeatToLength } from "./utils.js";

export function createQqOfficialWebhookValidationResponse(
  appSecret: string,
  request: QqOfficialWebhookValidationRequest
): QqOfficialWebhookValidationResponse {
  return {
    plain_token: request.plain_token,
    signature: signQqOfficialWebhookValidation(appSecret, request)
  };
}

export function signQqOfficialWebhookValidation(
  appSecret: string,
  request: QqOfficialWebhookValidationRequest
): string {
  const seed = repeatToLength(Buffer.from(appSecret, "utf8"), 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });
  const message = Buffer.from(`${request.event_ts}${request.plain_token}`, "utf8");

  return sign(null, message, privateKey).toString("hex");
}

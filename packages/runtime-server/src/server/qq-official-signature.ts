import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import type { NovaRequest } from "nova-http";

export interface QqOfficialSignatureValidationResult {
  readonly ok: boolean;
  readonly reason?: "missing_signature" | "missing_timestamp" | "malformed_signature" | "mismatch";
}

export function verifyQqOfficialCallbackSignature(
  appSecret: string,
  request: NovaRequest
): QqOfficialSignatureValidationResult {
  const signature = request.getHeader("x-signature-ed25519");
  const timestamp = request.getHeader("x-signature-timestamp");

  if (signature === undefined) {
    return { ok: false, reason: "missing_signature" };
  }

  if (timestamp === undefined) {
    return { ok: false, reason: "missing_timestamp" };
  }

  const signatureBytes = Buffer.from(signature, "hex");

  if (
    signatureBytes.length !== 64 ||
    signatureBytes.toString("hex") !== signature.toLowerCase() ||
    (signatureBytes[63]! & 224) !== 0
  ) {
    return { ok: false, reason: "malformed_signature" };
  }

  const message = Buffer.concat([Buffer.from(timestamp, "utf8"), request.body]);
  const ok = verify(null, message, createQqOfficialPublicKey(appSecret), signatureBytes);

  return ok ? { ok } : { ok, reason: "mismatch" };
}

function createQqOfficialPublicKey(appSecret: string): ReturnType<typeof createPublicKey> {
  const seed = createQqOfficialSeed(appSecret);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });

  return createPublicKey(privateKey);
}

function createQqOfficialSeed(appSecret: string): Buffer {
  if (appSecret.length === 0) {
    throw new Error("QQ official appSecret must not be empty.");
  }

  let seed = appSecret;

  while (Buffer.byteLength(seed, "utf8") < 32) {
    seed += seed;
  }

  return Buffer.from(seed, "utf8").subarray(0, 32);
}

import {
  createQqOfficialWebhookValidationResponse,
  QqOfficialChannelAdapter,
  type QqOfficialDispatchPayload,
  type QqOfficialWebhookValidationRequest
} from "@synapse/runtime-channel-qq-official";
import type { NovaRequest, NovaResponse } from "nova-http";
import type { RuntimeServerLogger } from "../types.js";
import { readJsonBody, sendJson } from "./http.js";
import { verifyQqOfficialCallbackSignature } from "./qq-official-signature.js";
import { summarizeQqOfficialPayload } from "./summaries.js";

export interface QqOfficialRoute {
  readonly path: string;
  readonly appSecret: string;
  readonly adapter: QqOfficialChannelAdapter;
}

export interface HandleQqOfficialWebhookOptions {
  readonly route: QqOfficialRoute;
  readonly request: NovaRequest;
  readonly response: NovaResponse;
  readonly awaitDispatch: boolean;
  readonly logger: RuntimeServerLogger;
}

export async function handleQqOfficialWebhook(options: HandleQqOfficialWebhookOptions): Promise<void> {
  const { route, request, response, awaitDispatch, logger } = options;
  const payload = readJsonBody(request);
  logger.info("Received QQ official webhook.", {
    route: route.path,
    bodySize: request.bodySize,
    contentType: request.getHeader("content-type"),
    signatureTimestampPresent: request.getHeader("x-signature-timestamp") !== undefined,
    signaturePresent: request.getHeader("x-signature-ed25519") !== undefined,
    payload: summarizeQqOfficialPayload(payload)
  });
  const validation = getQqOfficialValidationRequest(payload);

  if (validation !== undefined) {
    logger.info("Handled QQ official webhook validation challenge.", {
      route: route.path,
      eventTs: validation.event_ts,
      plainTokenLength: validation.plain_token.length
    });
    sendJson(response, 200, createQqOfficialWebhookValidationResponse(route.appSecret, validation));
    return;
  }

  const signature = verifyQqOfficialCallbackSignature(route.appSecret, request);

  if (!signature.ok) {
    logger.warn("Rejected QQ official webhook with invalid signature.", {
      route: route.path,
      reason: signature.reason ?? "unknown",
      payload: summarizeQqOfficialPayload(payload)
    });
    sendJson(response, 401, { ok: false, error: "invalid_signature" });
    return;
  }
  logger.info("Accepted QQ official webhook signature.", {
    route: route.path,
    payload: summarizeQqOfficialPayload(payload)
  });

  const dispatch = route.adapter.handlePayload(payload as QqOfficialDispatchPayload);

  if (awaitDispatch) {
    const events = await dispatch;
    logger.info("QQ official webhook dispatch completed.", {
      route: route.path,
      eventCount: events.length,
      events: events.map((event) => ({
        eventId: event.id,
        eventType: event.eventType,
        conversation: event.conversation,
        sender: event.sender,
        messageId: event.message?.id
      }))
    });
    sendJson(response, 200, { op: 12 });
    return;
  }

  void (async () => {
    try {
      const events = await dispatch;
      logger.info("QQ official webhook dispatch completed.", {
        route: route.path,
        eventCount: events.length,
        events: events.map((event) => ({
          eventId: event.id,
          eventType: event.eventType,
          conversation: event.conversation,
          sender: event.sender,
          messageId: event.message?.id
        }))
      });
    } catch (error) {
      logger.error("QQ official dispatch failed.", {
        route: route.path,
        payload: summarizeQqOfficialPayload(payload),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
  logger.info("Acked QQ official webhook before async dispatch completed.", {
    route: route.path,
    payload: summarizeQqOfficialPayload(payload)
  });
  sendJson(response, 200, { op: 12 });
}

function isQqOfficialValidationRequest(value: unknown): value is QqOfficialWebhookValidationRequest {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.plain_token === "string" && typeof value.event_ts === "string";
}

function getQqOfficialValidationRequest(payload: unknown): QqOfficialWebhookValidationRequest | undefined {
  if (isQqOfficialValidationRequest(payload)) {
    return payload;
  }

  if (!isRecord(payload) || payload.op !== 13 || !isQqOfficialValidationRequest(payload.d)) {
    return undefined;
  }

  return payload.d;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

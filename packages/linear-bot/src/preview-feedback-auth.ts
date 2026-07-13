import type { Context } from "hono";
import { timingSafeEqual } from "@open-inspect/shared";

import type { Env } from "./types";

export const PREVIEW_FEEDBACK_SIGNATURE_WINDOW_SECONDS = 5 * 60;

export type PreviewFeedbackAuthFailure =
  | "not_configured"
  | "request_too_large"
  | "invalid_signature"
  | "expired_signature";

export type PreviewFeedbackAuthResult =
  | { ok: true; nonce: string }
  | { ok: false; status: 401 | 413 | 503; reason: PreviewFeedbackAuthFailure };

export async function authenticatePreviewFeedbackRequest(
  c: Context<{ Bindings: Env }>,
  body: string,
  options: { maxBytes: number; nowMs?: number }
): Promise<PreviewFeedbackAuthResult> {
  const secret = c.env.PREVIEW_FEEDBACK_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    return { ok: false, status: 503, reason: "not_configured" };
  }
  if (new TextEncoder().encode(body).byteLength > options.maxBytes) {
    return { ok: false, status: 413, reason: "request_too_large" };
  }

  const timestamp = c.req.header("x-opsdna-feedback-timestamp") ?? "";
  const nonce = c.req.header("x-opsdna-feedback-nonce") ?? "";
  const signature = c.req.header("x-opsdna-feedback-signature") ?? "";
  if (!isUuid(nonce) || !/^\d{10}$/u.test(timestamp)) {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const timestampSeconds = Number(timestamp);
  if (Math.abs(nowSeconds - timestampSeconds) > PREVIEW_FEEDBACK_SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, status: 401, reason: "expired_signature" };
  }

  const bodyHash = await sha256Hex(body);
  const expected = `v1=${await hmacHex(secret, `v1\n${timestamp}\n${nonce}\n${bodyHash}`)}`;
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }
  return { ok: true, nonce };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

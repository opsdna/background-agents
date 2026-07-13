import type { Env } from "./types";
import { timingSafeEqual } from "@open-inspect/shared";

export type PreviewFeedbackAgentProfile = "research" | "implement";

export interface PreviewFeedbackDispatch {
  profile: PreviewFeedbackAgentProfile;
  repository: string;
  baseBranch: string;
}

export async function getPreviewFeedbackDispatch(
  env: Env,
  issueId: string,
  description: string | null | undefined
): Promise<PreviewFeedbackDispatch | null> {
  const secret = env.PREVIEW_FEEDBACK_DISPATCH_HMAC_SECRET;
  if (!secret || secret.length < 32 || !description) return null;
  const match = description.match(
    /<!-- opsdna-preview-dispatch:v1 payload=([A-Za-z0-9_-]+) signature=([0-9a-f]{64}) -->/u
  );
  if (!match) return null;
  const [, payload, signature] = match;
  const expected = await hmacHex(secret, payload!);
  if (!timingSafeEqual(signature!, expected)) return null;
  let value: unknown;
  try {
    value = JSON.parse(base64UrlDecode(payload!));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.version !== 1 || value.issueId !== issueId) return null;
  if (value.profile !== "research" && value.profile !== "implement") return null;
  if (
    typeof value.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) ||
    typeof value.baseBranch !== "string" ||
    value.baseBranch.length === 0 ||
    value.baseBranch.length > 500
  ) {
    return null;
  }
  return {
    profile: value.profile,
    repository: value.repository,
    baseBranch: value.baseBranch,
  };
}

export function previewFeedbackProfileInstructions(dispatch: PreviewFeedbackDispatch): string {
  const target = `origin/${dispatch.baseBranch}`;
  if (dispatch.profile === "research") {
    return [
      "## Trusted OpsDNA agent profile: Research",
      "Investigate the issue and relevant code. Expand the short report into a precise problem statement.",
      "Develop credible solution options, compare their tradeoffs, and recommend an implementation plan.",
      "Do not modify files, create commits, push branches, or open a pull request.",
      "End by asking for an explicit greenlight before implementation.",
      `The preview branch is ${target}; use it only as research context.`,
    ].join("\n");
  }
  return [
    "## Trusted OpsDNA agent profile: Implement",
    "Investigate first, expand the report, consider credible approaches, and choose the strongest plan.",
    "Implement the solution, run focused verification, and open a draft pull request.",
    `The pull request must target ${dispatch.baseBranch}; do not push directly to that branch.`,
    "Report what you found, alternatives considered, what you implemented or prototyped, verification performed, the PR URL, and remaining risks.",
  ].join("\n");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

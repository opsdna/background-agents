import type { Env } from "./types";

export type PreviewFeedbackAgentProfile = "research" | "implement";

export interface PreviewFeedbackDispatch {
  profile: PreviewFeedbackAgentProfile;
  repository: string;
  baseBranch: string;
}

const TTL_SECONDS = 8 * 24 * 60 * 60;

export async function storePreviewFeedbackDispatch(
  env: Env,
  issueId: string,
  dispatch: PreviewFeedbackDispatch
): Promise<void> {
  await env.LINEAR_KV.put(key(issueId), JSON.stringify(dispatch), {
    expirationTtl: TTL_SECONDS,
  });
}

export async function getPreviewFeedbackDispatch(
  env: Env,
  issueId: string
): Promise<PreviewFeedbackDispatch | null> {
  const raw = await env.LINEAR_KV.get(key(issueId));
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
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

function key(issueId: string): string {
  return `preview-feedback:dispatch:${issueId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

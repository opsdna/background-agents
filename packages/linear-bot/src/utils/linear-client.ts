/**
 * Linear API client utilities — OAuth + raw GraphQL.
 */

import {
  linearIssueDetailsResponseSchema,
  linearRepoSuggestionsResponseSchema,
  linearUserResponseSchema,
  type Env,
  type LinearIssueDetails,
} from "../types";
import { timingSafeEqual } from "@open-inspect/shared";
import { computeHmacHex } from "@open-inspect/shared";
import { createLogger } from "../logger";
import {
  getClientCredentialsTokenOrThrow,
  LINEAR_CLIENT_CREDENTIALS_SCOPE,
  LinearAuthError,
} from "./linear-credentials";
import { z } from "zod";

export {
  completeLinearOAuthInstallation,
  getClientCredentialsTokenOrThrow,
  LinearAuthError,
  type LinearAuthFailure,
  type LinearAuthFailureReason,
} from "./linear-credentials";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";

const linearCommentCreateResponseSchema = z.object({
  data: z
    .object({
      commentCreate: z
        .object({
          success: z.boolean(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

// ─── OAuth Helpers ───────────────────────────────────────────────────────────

export function buildOAuthAuthorizeUrl(env: Env): string {
  const authUrl = new URL("https://linear.app/oauth/authorize");
  authUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${env.WORKER_URL}/oauth/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", LINEAR_CLIENT_CREDENTIALS_SCOPE);
  authUrl.searchParams.set("actor", "app");
  return authUrl.toString();
}

// ─── Linear API Client ──────────────────────────────────────────────────────

export interface LinearApiClient {
  accessToken: string;
  organizationId: string;
  renewAccessToken: () => Promise<string>;
}

export interface CreatedLinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export async function createIssue(
  client: LinearApiClient,
  input: {
    teamId: string;
    title: string;
    description: string;
    projectId?: string;
    parentId?: string;
  }
): Promise<CreatedLinearIssue> {
  const result = await linearGraphQL(
    client,
    `
      mutation PreviewFeedbackIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }
    `,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      },
    }
  );
  const issue = (
    result as {
      data?: { issueCreate?: { success?: boolean; issue?: CreatedLinearIssue } };
    }
  ).data?.issueCreate;
  if (!issue?.success || !issue.issue) throw new Error("Linear issue creation failed");
  return issue.issue;
}

export async function uploadLinearImage(
  client: LinearApiClient,
  input: { mimeType: "image/png" | "image/webp"; bytes: Uint8Array; filename: string }
): Promise<string> {
  const result = await linearGraphQL(
    client,
    `
      mutation PreviewFeedbackFileUpload(
        $contentType: String!
        $filename: String!
        $size: Int!
      ) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success
          uploadFile {
            uploadUrl
            assetUrl
            headers { key value }
          }
        }
      }
    `,
    { contentType: input.mimeType, filename: input.filename, size: input.bytes.byteLength }
  );
  const payload = (
    result as {
      data?: {
        fileUpload?: {
          success?: boolean;
          uploadFile?: {
            uploadUrl?: string;
            assetUrl?: string;
            headers?: Array<{ key?: string; value?: string }>;
          };
        };
      };
    }
  ).data?.fileUpload;
  const upload = payload?.uploadFile;
  if (!payload?.success || !upload?.uploadUrl || !upload.assetUrl) {
    throw new Error("Linear file upload request failed");
  }

  const headers = new Headers({
    "content-type": input.mimeType,
    "cache-control": "public, max-age=31536000",
  });
  for (const header of upload.headers ?? []) {
    if (header.key && header.value) headers.set(header.key, header.value);
  }
  const uploadResponse = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers,
    body: input.bytes,
  });
  if (!uploadResponse.ok) throw new Error(`Linear file upload failed: ${uploadResponse.status}`);
  return upload.assetUrl;
}

export async function createIssueAttachment(
  client: LinearApiClient,
  input: {
    issueId: string;
    title: string;
    subtitle: string;
    url: string;
    metadata: Record<string, string | number>;
  }
): Promise<void> {
  const result = await linearGraphQL(
    client,
    `
      mutation PreviewFeedbackAttachmentCreate($input: AttachmentCreateInput!) {
        attachmentCreate(input: $input) { success }
      }
    `,
    { input }
  );
  const success = (result as { data?: { attachmentCreate?: { success?: boolean } } }).data
    ?.attachmentCreate?.success;
  if (!success) throw new Error("Linear attachment creation failed");
}

export interface CreatedLinearAgentSession {
  id: string;
  url: string | null;
  status: string;
}

export async function createAgentSessionOnIssue(
  client: LinearApiClient,
  issueId: string
): Promise<CreatedLinearAgentSession> {
  const result = await linearGraphQL(
    client,
    `
      mutation PreviewFeedbackAgentSessionCreate($input: AgentSessionCreateOnIssue!) {
        agentSessionCreateOnIssue(input: $input) {
          success
          agentSession { id url status }
        }
      }
    `,
    { input: { issueId } }
  );
  const payload = (
    result as {
      data?: {
        agentSessionCreateOnIssue?: {
          success?: boolean;
          agentSession?: CreatedLinearAgentSession;
        };
      };
    }
  ).data?.agentSessionCreateOnIssue;
  if (!payload?.success || !payload.agentSession) {
    throw new Error("Linear agent session creation failed");
  }
  return payload.agentSession;
}

export async function getLinearClient(
  env: Env,
  orgId: string,
  expectedAppUserId?: string
): Promise<LinearApiClient | null> {
  try {
    return await getLinearClientOrThrow(env, orgId, expectedAppUserId);
  } catch (err) {
    if (err instanceof LinearAuthError) return null;
    throw err;
  }
}

export async function getLinearClientOrThrow(
  env: Env,
  orgId: string,
  expectedAppUserId?: string
): Promise<LinearApiClient> {
  return {
    accessToken: await getClientCredentialsTokenOrThrow(env, orgId, { expectedAppUserId }),
    organizationId: orgId,
    renewAccessToken: () =>
      getClientCredentialsTokenOrThrow(env, orgId, {
        forceRenew: true,
        expectedAppUserId,
      }),
  };
}

/**
 * Execute a GraphQL query against the Linear API.
 */
export async function linearGraphQL(
  client: LinearApiClient,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ query, variables });
  const send = (accessToken: string) =>
    fetch(LINEAR_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body,
    });

  let res = await send(client.accessToken);
  if (res.status === 401) {
    log.warn("linear.graphql.unauthorized", { org_id: client.organizationId });
    let renewedToken: string;
    try {
      renewedToken = await client.renewAccessToken();
    } catch (error) {
      if (error instanceof LinearAuthError) throw error;
      throw new LinearAuthError({ reason: "client_credentials_error" });
    }
    client.accessToken = renewedToken;
    res = await send(renewedToken);
    if (res.status === 401) {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
      throw new LinearAuthError({
        reason: "client_credentials_rejected",
        status: res.status,
      });
    }
    if (res.ok) {
      log.info("linear.graphql.retry_succeeded", {
        org_id: client.organizationId,
        status: res.status,
      });
    } else {
      log.error("linear.graphql.retry_failed", {
        org_id: client.organizationId,
        status: res.status,
      });
    }
  }

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const msg = (json.errors[0] as { message?: string }).message ?? "Unknown GraphQL error";
    throw new Error(`Linear GraphQL error: ${msg}`);
  }

  return json;
}

// ─── Agent Activities ────────────────────────────────────────────────────────

export async function emitAgentActivity(
  client: LinearApiClient,
  agentSessionId: string,
  content: Record<string, unknown>,
  ephemeral?: boolean
): Promise<boolean> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) {
          success
        }
      }
    `,
      {
        input: { agentSessionId, content, ephemeral },
      }
    );
    return true;
  } catch (err) {
    log.error("linear.emit_activity_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}

// ─── Issue Details ───────────────────────────────────────────────────────────

/**
 * Fetch full issue details from Linear API.
 */
export async function fetchIssueDetails(
  client: LinearApiClient,
  issueId: string
): Promise<LinearIssueDetails | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query IssueDetails($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          priority
          priorityLabel
          labels { nodes { id name } }
          project { id name }
          assignee { id name }
          team { id key name }
          comments(first: 10, orderBy: createdAt) {
            nodes {
              body
              user { name }
            }
          }
        }
      }
    `,
      { id: issueId }
    );

    const parsed = linearIssueDetailsResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const issue = parsed.data.data?.issue;
    if (!issue) return null;

    return issue;
  } catch (err) {
    log.error("linear.fetch_issue_details", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Agent Session Management ────────────────────────────────────────────────

/**
 * Update an agent session (externalUrls, plan, etc.)
 */
export async function updateAgentSession(
  client: LinearApiClient,
  agentSessionId: string,
  input: Record<string, unknown>
): Promise<void> {
  try {
    await linearGraphQL(
      client,
      `
      mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) {
          success
        }
      }
    `,
      { id: agentSessionId, input }
    );
  } catch (err) {
    log.error("linear.update_session_failed", {
      agent_session_id: agentSessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

/**
 * Use Linear's built-in repo suggestion API for issue→repo matching.
 */
export async function getRepoSuggestions(
  client: LinearApiClient,
  issueId: string,
  agentSessionId: string,
  candidateRepos: Array<{ hostname: string; repositoryFullName: string }>
): Promise<Array<{ repositoryFullName: string; confidence: number }>> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query RepoSuggestions($issueId: String!, $agentSessionId: String!, $candidateRepositories: [IssueRepositorySuggestionInput!]!) {
        issueRepositorySuggestions(
          issueId: $issueId
          agentSessionId: $agentSessionId
          candidateRepositories: $candidateRepositories
        ) {
          suggestions {
            repositoryFullName
            confidence
          }
        }
      }
    `,
      { issueId, agentSessionId, candidateRepositories: candidateRepos }
    );

    const parsed = linearRepoSuggestionsResponseSchema.safeParse(data);
    if (!parsed.success) return [];

    return parsed.data.data?.issueRepositorySuggestions?.suggestions || [];
  } catch (err) {
    log.error("linear.repo_suggestions_failed", {
      issue_id: issueId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return [];
  }
}

// ─── User Lookup ────────────────────────────────────────────────────────────

/**
 * Fetch a Linear user by ID. Returns name and email for identity linking.
 */
export async function fetchUser(
  client: LinearApiClient,
  userId: string
): Promise<{ id: string; name: string; email: string | null } | null> {
  try {
    const data = await linearGraphQL(
      client,
      `
      query FetchUser($id: String!) {
        user(id: $id) {
          id
          name
          email
        }
      }
    `,
      { id: userId }
    );

    const parsed = linearUserResponseSchema.safeParse(data);
    if (!parsed.success) return null;

    const user = parsed.data.data?.user;
    if (!user) return null;

    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
    };
  } catch (err) {
    log.error("linear.fetch_user", {
      user_id: userId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
}

// ─── Webhook Verification ────────────────────────────────────────────────────

export async function verifyLinearWebhook(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;
  const expectedHex = await computeHmacHex(body, secret);
  return timingSafeEqual(signature, expectedHex);
}

// ─── Comment Posting (fallback) ──────────────────────────────────────────────

export async function postIssueComment(
  apiKey: string,
  issueId: string,
  body: string
): Promise<{ success: boolean }> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }
      `,
      variables: { input: { issueId, body } },
    }),
  });

  if (!response.ok) return { success: false };
  const result = linearCommentCreateResponseSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!result.success) return { success: false };
  return { success: result.data.data?.commentCreate?.success ?? false };
}

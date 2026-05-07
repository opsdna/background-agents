import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import {
  buildControlPlanePath,
  SESSION_CONTROL_PLANE_QUERY_PARAMS,
} from "@/lib/control-plane-query";

export async function GET(request: NextRequest) {
  const routeStart = Date.now();

  const session = await getServerSession(authOptions);
  const authMs = Date.now() - routeStart;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = buildControlPlanePath(
    "/sessions",
    request.nextUrl.searchParams,
    SESSION_CONTROL_PLANE_QUERY_PARAMS
  );

  // Server-trusted "filter to current user": when the client opts in via
  // `?mine=true`, derive identity from the NextAuth session and append the
  // canonical-resolution params for the control plane. The buildControlPlanePath
  // allowlist already strips any client-supplied mineScmUserId/mineProvider —
  // identity is *only* what the server derives here.
  const mineFlag = request.nextUrl.searchParams.get("mine") === "true";
  const finalPath = mineFlag && session.user?.id ? appendMineParams(path, session.user.id) : path;

  try {
    const fetchStart = Date.now();
    const response = await controlPlaneFetch(finalPath);
    const fetchMs = Date.now() - fetchStart;
    const data = await response.json();
    const totalMs = Date.now() - routeStart;

    console.log(
      `[sessions:GET] total=${totalMs}ms auth=${authMs}ms fetch=${fetchMs}ms status=${response.status}`
    );

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch sessions:", error);
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 });
  }
}

function appendMineParams(path: string, scmUserId: string): string {
  const sep = path.includes("?") ? "&" : "?";
  // session.user.id is the GitHub numeric ID for web NextAuth sessions; the
  // control plane resolves (provider, providerUserId) via UserStore.getIdentity.
  return `${path}${sep}mineScmUserId=${encodeURIComponent(scmUserId)}&mineProvider=github`;
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const jwt = await getToken({ req: request });
    const accessToken = jwt?.accessToken as string | undefined;

    // Explicitly pick allowed fields from client body and derive identity
    // from the server-side NextAuth session (not client-supplied data)
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    const sessionBody = {
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
      branch: body.branch,
      title: body.title,
      spawnSource: "user" as const,
      scmToken: accessToken,
      scmRefreshToken: jwt?.refreshToken as string | undefined,
      scmTokenExpiresAt: jwt?.accessTokenExpiresAt as number | undefined,
      scmUserId: user.id,
      userId,
      scmLogin: user.login,
      scmName: user.name,
      scmEmail: user.email,
      scmAvatarUrl: user.image,
    };

    const response = await controlPlaneFetch("/sessions", {
      method: "POST",
      body: JSON.stringify(sessionBody),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create session:", error);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}

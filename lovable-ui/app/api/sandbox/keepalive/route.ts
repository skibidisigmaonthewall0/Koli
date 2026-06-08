import { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { sandboxId } = await req.json();
    if (!sandboxId) {
      return Response.json({ error: "sandboxId is required" }, { status: 400 });
    }

    const { keepSandboxAlive } = await import("@/lib/daytona-sandbox");
    await keepSandboxAlive(sandboxId);

    return Response.json({ ok: true });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to refresh sandbox";
    return Response.json({ error: message }, { status: 500 });
  }
}

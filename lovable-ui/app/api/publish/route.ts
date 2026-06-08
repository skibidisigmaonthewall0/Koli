import { NextRequest } from "next/server";
import { publishSite } from "@/lib/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { sandboxId, projectName } = await req.json();

    if (!sandboxId || !projectName) {
      return Response.json(
        { error: "sandboxId and projectName are required" },
        { status: 400 }
      );
    }

    if (!process.env.DAYTONA_API_KEY) {
      return Response.json({ error: "DAYTONA_API_KEY not set" }, { status: 500 });
    }

    const result = await publishSite(sandboxId, projectName);
    return Response.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Publish failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

import { NextRequest } from "next/server";
import {
  deleteSandbox,
  listProjectFiles,
  readProjectFile,
} from "@/lib/sandbox-utils";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest) {
  try {
    const { sandboxId } = await req.json();
    if (!sandboxId) {
      return Response.json({ error: "sandboxId is required" }, { status: 400 });
    }

    if (!process.env.DAYTONA_API_KEY) {
      return Response.json({ error: "DAYTONA_API_KEY not set" }, { status: 500 });
    }

    await deleteSandbox(sandboxId);
    return Response.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Delete failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const sandboxId = req.nextUrl.searchParams.get("sandboxId");
    const filePath = req.nextUrl.searchParams.get("path");

    if (!sandboxId) {
      return Response.json({ error: "sandboxId is required" }, { status: 400 });
    }

    if (!process.env.DAYTONA_API_KEY) {
      return Response.json({ error: "DAYTONA_API_KEY not set" }, { status: 500 });
    }

    if (filePath) {
      const content = await readProjectFile(sandboxId, filePath);
      return Response.json({ path: filePath, content });
    }

    const files = await listProjectFiles(sandboxId);
    return Response.json({ files });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Request failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

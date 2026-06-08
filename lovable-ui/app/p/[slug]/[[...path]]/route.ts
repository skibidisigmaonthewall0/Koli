import { NextRequest } from "next/server";
import { head } from "@vercel/blob";

export const runtime = "nodejs";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
};

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return MIME[ext] || "application/octet-stream";
}

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string; path?: string[] } }
) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return new Response("Publishing is not configured.", { status: 503 });
  }

  const slug = params.slug;
  let filePath = params.path?.join("/") || "index.html";

  if (filePath.endsWith("/")) {
    filePath += "index.html";
  }

  if (!filePath.includes(".")) {
    filePath = `${filePath}/index.html`.replace(/\/+/g, "/");
  }

  async function fetchBlob(path: string) {
    const meta = await head(`published/${slug}/${path}`, { token });
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return res.arrayBuffer();
  }

  try {
    let content = await fetchBlob(filePath);
    if (!content) {
      content = await fetchBlob("index.html");
    }
    if (!content) {
      return new Response("Site not found", { status: 404 });
    }

    return new Response(content, {
      headers: { "Content-Type": guessMime(filePath) },
    });
  } catch {
    return new Response("Site not found", { status: 404 });
  }
}

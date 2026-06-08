import { findSandbox, getIframePreviewUrl } from "./daytona-sandbox";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "project";
}

export async function publishSiteFromSandbox(
  sandboxId: string,
  projectName: string
): Promise<{ url: string; slug: string }> {
  const slug = slugify(projectName);
  const sandbox = await findSandbox(sandboxId);

  if (typeof sandbox.getSignedPreviewUrl === "function") {
    const signed = await sandbox.getSignedPreviewUrl(3000, 86400);
    return { url: signed.url, slug };
  }

  const previewUrl = await getIframePreviewUrl(sandbox, 3000);
  const appBase =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://koli-sooty.vercel.app");

  return {
    url: `${appBase}/share/${slug}?sandbox=${sandboxId}`,
    slug,
  };
}

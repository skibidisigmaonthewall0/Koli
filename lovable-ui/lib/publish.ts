import { getSandbox, PROJECT_DIR } from "./sandbox-utils";
import { getPublishedUrls, slugify } from "./slug";

export interface PublishResult {
  slug: string;
  url: string;
  pathUrl: string;
  fileCount: number;
}

async function uploadToBlob(slug: string, path: string, content: Buffer) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set. Add it in Vercel env vars to enable publishing."
    );
  }

  const { put } = await import("@vercel/blob");
  await put(`published/${slug}/${path}`, content, {
    access: "public",
    addRandomSuffix: false,
    token,
  });
}

export async function publishSite(
  sandboxId: string,
  projectName: string,
  onLog?: (message: string) => void
): Promise<PublishResult> {
  const log = (msg: string) => onLog?.(msg);
  const slug = slugify(projectName);
  const { sandbox } = await getSandbox(sandboxId);
  const rootDir = await sandbox.getUserRootDir();

  log("📦 Building static site for publish...");

  await sandbox.process.executeCommand(
    `cat > ${PROJECT_DIR}/next.config.mjs << 'EOF'
/** @type {import('next').NextConfig} */
const nextConfig = { output: "export" };
export default nextConfig;
EOF`,
    rootDir,
    undefined,
    30000
  );

  const build = await sandbox.process.executeCommand(
    `cd ${PROJECT_DIR} && npm run build`,
    rootDir,
    undefined,
    300000
  );

  if (build.exitCode !== 0) {
    throw new Error(`Build failed: ${build.result || "unknown error"}`);
  }

  log("✓ Build complete, collecting files...");

  const listResult = await sandbox.process.executeCommand(
    `find ${PROJECT_DIR}/out -type f | sort`,
    rootDir,
    undefined,
    60000
  );

  const filePaths = (listResult.result || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/out/"));

  if (filePaths.length === 0) {
    throw new Error("No static files found after build");
  }

  let uploaded = 0;
  for (const fullPath of filePaths) {
    const relative = fullPath.split("/out/")[1];
    if (!relative) continue;

    const buffer = await sandbox.fs.downloadFile(fullPath, 120000);
    await uploadToBlob(slug, relative, buffer);
    uploaded += 1;
    log(`✓ Uploaded ${relative}`);
  }

  const urls = getPublishedUrls(slug);
  log(`✨ Published to ${urls.subdomain}`);

  return {
    slug,
    url: urls.subdomain,
    pathUrl: urls.path,
    fileCount: uploaded,
  };
}

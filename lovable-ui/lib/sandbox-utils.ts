import { Daytona } from "@daytonaio/sdk";

export const PROJECT_DIR = "website-project";

export async function getSandbox(sandboxId: string) {
  const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! });
  const sandboxes = await daytona.list();
  const sandbox = sandboxes.find((s: { id: string }) => s.id === sandboxId);
  if (!sandbox) {
    throw new Error(`Sandbox ${sandboxId} not found`);
  }
  return { daytona, sandbox };
}

export async function deleteSandbox(sandboxId: string): Promise<void> {
  const { daytona, sandbox } = await getSandbox(sandboxId);
  await daytona.delete(sandbox);
}

export async function listProjectFiles(sandboxId: string): Promise<string[]> {
  const { sandbox } = await getSandbox(sandboxId);
  const rootDir = await sandbox.getUserRootDir();
  const result = await sandbox.process.executeCommand(
    `find ${PROJECT_DIR} -type f ! -path '*/node_modules/*' ! -path '*/.next/*' | sort`,
    rootDir,
    undefined,
    60000
  );

  const lines = (result.result || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => line.replace(`${PROJECT_DIR}/`, ""));
}

export async function readProjectFile(
  sandboxId: string,
  relativePath: string
): Promise<string> {
  const { sandbox } = await getSandbox(sandboxId);
  const buffer = await sandbox.fs.downloadFile(
    `${PROJECT_DIR}/${relativePath}`,
    60000
  );
  return buffer.toString("utf-8");
}

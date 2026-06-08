import { Daytona } from "@daytonaio/sdk";

export type DaytonaSandbox = Awaited<ReturnType<typeof findSandbox>>;

export function getDaytona() {
  if (!process.env.DAYTONA_API_KEY) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  return new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
}

export async function findSandbox(sandboxId: string) {
  const daytona = getDaytona();
  return daytona.get(sandboxId);
}

export async function getSandboxRootDir(sandbox: DaytonaSandbox): Promise<string> {
  const dir =
    (await sandbox.getUserHomeDir()) ||
    (await sandbox.getUserRootDir()) ||
    "/home/daytona";
  return dir;
}

export async function getIframePreviewUrl(
  sandbox: DaytonaSandbox,
  port = 3000
): Promise<string> {
  if (typeof sandbox.getSignedPreviewUrl === "function") {
    const signed = await sandbox.getSignedPreviewUrl(port, 3600);
    return signed.url;
  }

  const preview = await sandbox.getPreviewLink(port);
  return preview.url;
}

export async function deleteSandbox(sandboxId: string) {
  const sandbox = await findSandbox(sandboxId);
  await sandbox.delete();
}

export async function keepSandboxAlive(sandboxId: string) {
  const sandbox = await findSandbox(sandboxId);
  if (typeof sandbox.refreshActivity === "function") {
    await sandbox.refreshActivity();
  }
}

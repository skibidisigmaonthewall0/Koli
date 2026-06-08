import {
  generateFilesWithGroq,
  generateFollowUpFiles,
  type GeneratedFile,
} from "./groq-generate";
import { getNextJsScaffold } from "./nextjs-scaffold";
import {
  findSandbox,
  getDaytona,
  getIframePreviewUrl,
  getSandboxRootDir,
  type DaytonaSandbox,
} from "./daytona-sandbox";

export interface DaytonaGenerateResult {
  success: boolean;
  sandboxId: string;
  projectDir: string;
  previewUrl: string;
  files: GeneratedFile[];
}

export interface DaytonaGenerateOptions {
  sandboxId?: string;
  prompt: string;
  followUp?: string;
  originalPrompt?: string;
  onLog?: (line: string) => void;
  onSandboxReady?: (sandboxId: string) => void;
}

const PROJECT_DIR = "website-project";
const COMPONENT_FILE = `${PROJECT_DIR}/components/AppContent.tsx`;
const PAGE_FILE = `${PROJECT_DIR}/app/page.tsx`;

function createLogger(onLog?: (line: string) => void) {
  return (message: string) => {
    console.log(message);
    onLog?.(message);
  };
}

async function waitForDevServer(
  sandbox: DaytonaSandbox,
  rootDir: string,
  log: (message: string) => void
) {
  log("Waiting for dev server...");
  for (let attempt = 0; attempt < 20; attempt++) {
    const check = await sandbox.process.executeCommand(
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000 || echo fail`,
      rootDir,
      undefined,
      15000
    );
    const status = check.result?.trim();
    if (status === "200" || status === "304") {
      log("✓ Dev server is ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  log("⚠️ Dev server may still be starting...");
}

async function uploadFiles(
  sandbox: DaytonaSandbox,
  files: GeneratedFile[],
  log: (message: string) => void
) {
  log("\n4. Uploading files to sandbox...");
  await sandbox.fs.uploadFiles(
    files.map((file) => ({
      source: Buffer.from(file.content, "utf-8"),
      destination: `${PROJECT_DIR}/${file.path}`,
    })),
    120000
  );

  for (const file of files) {
    log(`✓ Uploaded ${file.path}`);
    log(
      `__TOOL_USE__ ${JSON.stringify({
        type: "tool_use",
        name: "Write",
        input: { file_path: file.path },
      })}`
    );
  }
}

async function installAndStartServer(
  sandbox: DaytonaSandbox,
  rootDir: string,
  log: (message: string) => void,
  options: { fresh: boolean }
) {
  if (options.fresh) {
    log("\n5. Installing dependencies...");
    const npmInstall = await sandbox.process.executeCommand(
      `cd ${PROJECT_DIR} && npm install`,
      rootDir,
      undefined,
      300000
    );
    log(npmInstall.result || "");

    if (npmInstall.exitCode !== 0) {
      throw new Error(`npm install failed: ${npmInstall.result || "unknown error"}`);
    }
    log("✓ Dependencies installed");
  }

  log("\n6. Starting dev server...");
  await sandbox.process.executeCommand(
    `pkill -f "next dev" 2>/dev/null || true`,
    rootDir
  );
  await sandbox.process.executeCommand(
    `cd ${PROJECT_DIR} && nohup npm run dev -- -p 3000 -H 0.0.0.0 > dev-server.log 2>&1 &`,
    rootDir,
    { PORT: "3000" }
  );

  await waitForDevServer(sandbox, rootDir, log);
}

export async function generateWebsiteInDaytona({
  sandboxId: sandboxIdArg,
  prompt,
  onLog,
  onSandboxReady,
}: DaytonaGenerateOptions): Promise<DaytonaGenerateResult> {
  const log = createLogger(onLog);

  log("🚀 Starting website generation...\n");

  if (!process.env.DAYTONA_API_KEY || !process.env.GROQ_API_KEY) {
    throw new Error("DAYTONA_API_KEY and GROQ_API_KEY must be set");
  }

  const daytona = getDaytona();
  let sandbox: DaytonaSandbox | undefined;
  let sandboxId = sandboxIdArg;

  try {
    if (sandboxId) {
      log(`1. Using existing sandbox: ${sandboxId}`);
      sandbox = await findSandbox(sandboxId);
      log(`✓ Connected to sandbox: ${sandbox.id}`);
    } else {
      log("1. Creating Daytona sandbox...");
      sandbox = await daytona.create(
        { image: "node:20", public: true },
        { timeout: 120 }
      );
      sandboxId = sandbox.id;
      log(`✓ Sandbox created: ${sandboxId}`);
      onSandboxReady?.(sandboxId);
    }

    const rootDir = await getSandboxRootDir(sandbox);

    log("\n2. Setting up project + generating code in parallel...");
    await sandbox.fs.createFolder(PROJECT_DIR, "755");

    const scaffold = getNextJsScaffold();
    const npmPromise = (async () => {
      await uploadFiles(sandbox!, scaffold, log);
      log("\n3. Installing scaffold dependencies (while AI writes code)...");
      const npmInstall = await sandbox!.process.executeCommand(
        `cd ${PROJECT_DIR} && npm install`,
        rootDir,
        undefined,
        300000
      );
      if (npmInstall.exitCode !== 0) {
        throw new Error(`npm install failed: ${npmInstall.result || "unknown error"}`);
      }
      log("✓ Scaffold dependencies installed");
    })();

    log(`\nGenerating code for: "${prompt}"`);
    const aiFilesPromise = generateFilesWithGroq(prompt, log);

    const [, aiFiles] = await Promise.all([npmPromise, aiFilesPromise]);
    const aiOnly = aiFiles.filter(
      (f) => f.path === "components/AppContent.tsx" || f.path === "app/page.tsx"
    );
    const allFiles = [...scaffold, ...aiOnly];

    await uploadFiles(sandbox, aiOnly, log);
    await installAndStartServer(sandbox, rootDir, log, { fresh: false });

    log("\n7. Getting preview URL...");
    const previewUrl = await getIframePreviewUrl(sandbox, 3000);

    log("\n✨ SUCCESS!");
    log(`Sandbox ID: ${sandboxId}`);
    log(`Preview URL: ${previewUrl}`);

    return {
      success: true,
      sandboxId: sandboxId!,
      projectDir: `${rootDir}/${PROJECT_DIR}`,
      previewUrl,
      files: allFiles,
    };
  } catch (error) {
    if (sandbox && sandboxId) {
      log(`\nSandbox ID: ${sandboxId}`);
    }
    throw error;
  }
}

export async function iterateWebsiteInDaytona({
  sandboxId,
  originalPrompt,
  followUp,
  onLog,
}: {
  sandboxId: string;
  originalPrompt: string;
  followUp: string;
  onLog?: (line: string) => void;
}): Promise<DaytonaGenerateResult> {
  const log = createLogger(onLog);

  log("🔄 Applying follow-up changes...\n");

  if (!process.env.DAYTONA_API_KEY || !process.env.GROQ_API_KEY) {
    throw new Error("DAYTONA_API_KEY and GROQ_API_KEY must be set");
  }

  const sandbox = await findSandbox(sandboxId);
  log(`✓ Connected to sandbox: ${sandboxId}`);
  const rootDir = await getSandboxRootDir(sandbox);

  log("\n2. Reading current code from sandbox...");
  const existingComponent = (
    await sandbox.fs.downloadFile(COMPONENT_FILE, 60000)
  ).toString("utf-8");
  const existingPage = (
    await sandbox.fs.downloadFile(PAGE_FILE, 60000)
  ).toString("utf-8");
  log("✓ Loaded existing files");

  log(`\n3. Follow-up: "${followUp}"`);

  const files = await generateFollowUpFiles(
    {
      originalPrompt,
      followUp,
      existingComponent,
      existingPage,
    },
    log
  );

  await uploadFiles(sandbox, files, log);
  await installAndStartServer(sandbox, rootDir, log, { fresh: false });

  log("\n4. Getting preview URL...");
  const previewUrl = await getIframePreviewUrl(sandbox, 3000);

  log("\n✨ Follow-up applied!");
  log(`Preview URL: ${previewUrl}`);

  const scaffold = getNextJsScaffold();

  return {
    success: true,
    sandboxId,
    projectDir: `${rootDir}/${PROJECT_DIR}`,
    previewUrl,
    files: [...scaffold, ...files],
  };
}

export { deleteSandbox, keepSandboxAlive } from "./daytona-sandbox";

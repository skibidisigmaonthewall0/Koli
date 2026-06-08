import { Daytona } from "@daytonaio/sdk";
import {
  generateFilesWithGroq,
  generateFollowUpFiles,
  type GeneratedFile,
} from "./groq-generate";

export interface DaytonaGenerateResult {
  success: boolean;
  sandboxId: string;
  projectDir: string;
  previewUrl: string;
  files?: GeneratedFile[];
}

export interface DaytonaGenerateOptions {
  sandboxId?: string;
  prompt: string;
  followUp?: string;
  originalPrompt?: string;
  onLog?: (line: string) => void;
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

export async function generateWebsiteInDaytona({
  sandboxId: sandboxIdArg,
  prompt,
  onLog,
}: DaytonaGenerateOptions): Promise<DaytonaGenerateResult> {
  const log = createLogger(onLog);

  log("🚀 Starting website generation...\n");

  if (!process.env.DAYTONA_API_KEY || !process.env.GROQ_API_KEY) {
    throw new Error("DAYTONA_API_KEY and GROQ_API_KEY must be set");
  }

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
  });

  let sandbox: Awaited<ReturnType<Daytona["create"]>> | undefined;
  let sandboxId = sandboxIdArg;

  try {
    if (sandboxId) {
      log(`1. Using existing sandbox: ${sandboxId}`);
      const sandboxes = await daytona.list();
      sandbox = sandboxes.find((s: { id: string }) => s.id === sandboxId);
      if (!sandbox) {
        throw new Error(`Sandbox ${sandboxId} not found`);
      }
      log(`✓ Connected to sandbox: ${sandbox.id}`);
    } else {
      log("1. Creating Daytona sandbox...");
      sandbox = await daytona.create({
        public: true,
        image: "node:20",
      });
      sandboxId = sandbox.id;
      log(`✓ Sandbox created: ${sandboxId}`);
    }

    const rootDir = await sandbox.getUserRootDir();

    log("\n2. Setting up project directory...");
    await sandbox.fs.createFolder(PROJECT_DIR, "755");
    log(`✓ Project directory ready`);

    log("\n3. Generating code with Groq (on server)...");
    log(`Prompt: "${prompt}"`);

    const files = await generateFilesWithGroq(prompt, log);

    await uploadFiles(sandbox, files, log);
    emitFilesEvent(files, log);
    await installAndStartServer(sandbox, rootDir, log, { fresh: true });

    log("\n7. Getting preview URL...");
    const preview = await sandbox.getPreviewLink(3000);

    log("\n✨ SUCCESS!");
    log(`Sandbox ID: ${sandboxId}`);
    log(`Preview URL: ${preview.url}`);

    return {
      success: true,
      sandboxId: sandboxId!,
      projectDir: `${rootDir}/${PROJECT_DIR}`,
      previewUrl: preview.url,
      files,
    };
  } catch (error) {
    if (sandbox && sandboxId) {
      log(`\nSandbox ID: ${sandboxId}`);
    }
    throw error;
  }
}

async function uploadFiles(
  sandbox: { fs: { uploadFiles: (files: { source: Buffer; destination: string }[], timeout?: number) => Promise<void> } },
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
  sandbox: { process: { executeCommand: (cmd: string, cwd?: string, env?: Record<string, string>, timeout?: number) => Promise<{ exitCode?: number; result?: string }> } },
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

  log("Waiting for server...");
  await new Promise((resolve) => setTimeout(resolve, options.fresh ? 12000 : 8000));
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

  const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  const sandboxes = await daytona.list();
  const sandbox = sandboxes.find((s: { id: string }) => s.id === sandboxId);

  if (!sandbox) {
    throw new Error(`Sandbox ${sandboxId} not found`);
  }

  log(`✓ Connected to sandbox: ${sandboxId}`);
  const rootDir = await sandbox.getUserRootDir();

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
  emitFilesEvent(files, log);
  await installAndStartServer(sandbox, rootDir, log, { fresh: false });

  log("\n4. Getting preview URL...");
  const preview = await sandbox.getPreviewLink(3000);

  log("\n✨ Follow-up applied!");
  log(`Preview URL: ${preview.url}`);

  return {
    success: true,
    sandboxId,
    projectDir: `${rootDir}/${PROJECT_DIR}`,
    previewUrl: preview.url,
    files,
  };
}

function emitFilesEvent(files: GeneratedFile[], log: (message: string) => void) {
  log(
    `__FILES__ ${JSON.stringify({
      files: files.map((f) => ({ path: f.path, content: f.content })),
    })}`
  );
}

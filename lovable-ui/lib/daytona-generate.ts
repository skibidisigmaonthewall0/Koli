import { Daytona } from "@daytonaio/sdk";
import { generateFilesWithGroq } from "./groq-generate";

export interface DaytonaGenerateResult {
  success: boolean;
  sandboxId: string;
  projectDir: string;
  previewUrl: string;
}

export interface DaytonaGenerateOptions {
  sandboxId?: string;
  prompt: string;
  onLog?: (line: string) => void;
}

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
    const projectDir = "website-project";

    log("\n2. Setting up project directory...");
    await sandbox.fs.createFolder(projectDir, "755");
    log(`✓ Project directory ready`);

    log("\n3. Generating code with Groq (on server)...");
    log(`Prompt: "${prompt}"`);

    const files = await generateFilesWithGroq(prompt, log);

    log("\n4. Uploading files to sandbox...");
    await sandbox.fs.uploadFiles(
      files.map((file) => ({
        source: Buffer.from(file.content, "utf-8"),
        destination: `${projectDir}/${file.path}`,
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

    log("\n5. Installing dependencies...");
    const npmInstall = await sandbox.process.executeCommand(
      `cd ${projectDir} && npm install`,
      rootDir,
      undefined,
      300000
    );
    log(npmInstall.result || "");

    if (npmInstall.exitCode !== 0) {
      throw new Error(`npm install failed: ${npmInstall.result || "unknown error"}`);
    }
    log("✓ Dependencies installed");

    log("\n6. Starting dev server...");
    await sandbox.process.executeCommand(
      `cd ${projectDir} && nohup npm run dev -- -p 3000 -H 0.0.0.0 > dev-server.log 2>&1 &`,
      rootDir,
      { PORT: "3000" }
    );

    log("Waiting for server...");
    await new Promise((resolve) => setTimeout(resolve, 12000));

    log("\n7. Getting preview URL...");
    const preview = await sandbox.getPreviewLink(3000);

    log("\n✨ SUCCESS!");
    log(`Sandbox ID: ${sandboxId}`);
    log(`Preview URL: ${preview.url}`);

    return {
      success: true,
      sandboxId: sandboxId!,
      projectDir: `${rootDir}/${projectDir}`,
      previewUrl: preview.url,
    };
  } catch (error) {
    if (sandbox && sandboxId) {
      log(`\nSandbox ID: ${sandboxId}`);
    }
    throw error;
  }
}

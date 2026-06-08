import { Daytona } from "@daytonaio/sdk";
import { buildSandboxGenerateScript } from "./sandbox-generate-script";

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

  log("🚀 Starting website generation in Daytona sandbox...\n");

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
      log("1. Creating new Daytona sandbox...");
      sandbox = await daytona.create({
        public: true,
        image: "node:20",
      });
      sandboxId = sandbox.id;
      log(`✓ Sandbox created: ${sandboxId}`);
    }

    const rootDir = await sandbox.getUserRootDir();
    log(`✓ Working directory: ${rootDir}`);

    log("\n2. Setting up project directory...");
    const projectDir = `${rootDir}/website-project`;
    await sandbox.process.executeCommand(`mkdir -p "${projectDir}"`, rootDir);
    log(`✓ Created project directory: ${projectDir}`);

    log("\n3. Writing Groq generation script...");
    const scriptB64 = Buffer.from(buildSandboxGenerateScript()).toString("base64");
    const writeScript = await sandbox.process.executeCommand(
      `echo "${scriptB64}" | base64 -d > "${projectDir}/generate.mjs"`,
      rootDir,
      undefined,
      30000
    );

    if (writeScript.exitCode !== 0) {
      throw new Error(`Failed to write generation script: ${writeScript.result}`);
    }
    log("✓ Generation script ready");

    log("\n4. Generating website with Groq...");
    log(`Prompt: "${prompt}"`);

    const genResult = await sandbox.process.executeCommand(
      `cd "${projectDir}" && node generate.mjs`,
      rootDir,
      {
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        GROQ_MODEL: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
        USER_PROMPT_B64: Buffer.from(prompt).toString("base64"),
      },
      300000
    );

    log(genResult.result || "");

    if (genResult.exitCode !== 0) {
      throw new Error(`Generation failed: ${genResult.result || "unknown error"}`);
    }
    log("✓ Website files generated");

    log("\n5. Installing dependencies...");
    const npmInstall = await sandbox.process.executeCommand(
      `cd "${projectDir}" && npm install`,
      rootDir,
      undefined,
      300000
    );
    log(npmInstall.result || "");

    if (npmInstall.exitCode !== 0) {
      throw new Error(`npm install failed: ${npmInstall.result || "unknown error"}`);
    }
    log("✓ Dependencies installed");

    log("\n6. Starting development server...");
    await sandbox.process.executeCommand(
      `cd "${projectDir}" && nohup npm run dev -- -p 3000 -H 0.0.0.0 > dev-server.log 2>&1 &`,
      rootDir,
      { PORT: "3000" }
    );

    log("Waiting for server to start...");
    await new Promise((resolve) => setTimeout(resolve, 10000));

    const checkServer = await sandbox.process.executeCommand(
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000 || echo failed`,
      projectDir
    );
    log(`Server check: ${checkServer.result?.trim() || "unknown"}`);

    log("\n7. Getting preview URL...");
    const preview = await sandbox.getPreviewLink(3000);

    log("\n✨ SUCCESS! Website generated!");
    log(`Sandbox ID: ${sandboxId}`);
    log(`Preview URL: ${preview.url}`);

    return {
      success: true,
      sandboxId: sandboxId!,
      projectDir,
      previewUrl: preview.url,
    };
  } catch (error) {
    if (sandbox && sandboxId) {
      log(`\nSandbox ID: ${sandboxId}`);
    }
    throw error;
  }
}

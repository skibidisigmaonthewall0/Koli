import { Daytona } from "@daytonaio/sdk";
import { getGroqRouterConfig } from "./groq-config";

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
    await sandbox.process.executeCommand(`mkdir -p ${projectDir}`, rootDir);
    log(`✓ Created project directory: ${projectDir}`);

    log("\n3. Initializing npm project...");
    await sandbox.process.executeCommand("npm init -y", projectDir);
    log("✓ Package.json created");

    log("\n4. Installing Claude Code SDK and Groq router...");
    const installResult = await sandbox.process.executeCommand(
      "npm install @anthropic-ai/claude-code@latest @musistudio/claude-code-router@latest",
      projectDir,
      undefined,
      180000
    );

    if (installResult.exitCode !== 0) {
      throw new Error("Failed to install Claude Code SDK");
    }
    log("✓ Claude Code SDK and Groq router installed");

    log("\n5. Configuring Groq router...");
    const routerConfig = JSON.stringify(getGroqRouterConfig());
    await sandbox.process.executeCommand("mkdir -p ~/.claude-code-router", projectDir);
    await sandbox.process.executeCommand(
      `cat > ~/.claude-code-router/config.json << 'ROUTER_CONFIG_EOF'\n${routerConfig}\nROUTER_CONFIG_EOF`,
      projectDir
    );
    log("✓ Groq router configured");

    log("\n6. Starting Groq router...");
    await sandbox.process.executeCommand(
      "nohup node node_modules/@musistudio/claude-code-router/dist/cli.js start > groq-router.log 2>&1 &",
      projectDir,
      { GROQ_API_KEY: process.env.GROQ_API_KEY }
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    log("✓ Groq router started");

    log("\n7. Creating generation script...");
    const generationScript = `const { query } = require('@anthropic-ai/claude-code');
const fs = require('fs');

async function generateWebsite() {
  const prompt = \`${prompt.replace(/`/g, "\\`")}

  Important requirements:
  - Create a NextJS app with TypeScript and Tailwind CSS
  - Use the app directory structure
  - Create all files in the current directory
  - Include a package.json with all necessary dependencies
  - Make the design modern and responsive
  - Add at least a home page and one other page
  - Include proper navigation between pages
  \`;

  const messages = [];
  const abortController = new AbortController();

  try {
    for await (const message of query({
      prompt: prompt,
      abortController: abortController,
      options: {
        maxTurns: 20,
        allowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'LS', 'Glob', 'Grep']
      }
    })) {
      messages.push(message);

      if (message.type === 'text') {
        console.log('[Claude]:', (message.text || '').substring(0, 80) + '...');
        console.log('__CLAUDE_MESSAGE__', JSON.stringify({ type: 'assistant', content: message.text }));
      } else if (message.type === 'tool_use') {
        console.log('[Tool]:', message.name, message.input?.file_path || '');
        console.log('__TOOL_USE__', JSON.stringify({ type: 'tool_use', name: message.name, input: message.input }));
      } else if (message.type === 'result') {
        console.log('__TOOL_RESULT__', JSON.stringify({ type: 'tool_result', result: message.result }));
      }
    }

    fs.writeFileSync('generation-log.json', JSON.stringify(messages, null, 2));
  } catch (error) {
    console.error('Generation error:', error);
    process.exit(1);
  }
}

generateWebsite().catch(console.error);`;

    await sandbox.process.executeCommand(
      `cat > generate.js << 'SCRIPT_EOF'\n${generationScript}\nSCRIPT_EOF`,
      projectDir
    );
    log("✓ Generation script written");

    log("\n8. Running code generation with Groq...");
    log(`Prompt: "${prompt}"`);

    const genResult = await sandbox.process.executeCommand(
      "node generate.js",
      projectDir,
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
        ANTHROPIC_API_KEY: "groq-router",
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        NODE_PATH: `${projectDir}/node_modules`,
      },
      600000
    );

    log("\nGeneration output:");
    log(genResult.result || "");

    if (genResult.exitCode !== 0) {
      throw new Error("Generation failed");
    }

    const hasNextJS = await sandbox.process.executeCommand(
      "test -f package.json && grep -q next package.json && echo yes || echo no",
      projectDir
    );

    if (hasNextJS.result?.trim() === "yes") {
      log("\n9. Installing project dependencies...");
      await sandbox.process.executeCommand("npm install", projectDir, undefined, 300000);

      log("\n10. Starting development server...");
      await sandbox.process.executeCommand(
        "nohup npm run dev > dev-server.log 2>&1 &",
        projectDir,
        { PORT: "3000" }
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    log("\n11. Getting preview URL...");
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

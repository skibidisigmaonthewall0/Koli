import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

const ROUTER_PORT = 3456;
const ROUTER_HOST = "127.0.0.1";
const ROUTER_BASE_URL = `http://${ROUTER_HOST}:${ROUTER_PORT}`;
const CONFIG_DIR = path.join(os.homedir(), ".claude-code-router");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

let routerProcess: ChildProcess | null = null;

function getGroqModel(): string {
  return process.env.GROQ_MODEL || "qwen/qwen3-32b";
}

export function getGroqRouterConfig(): Record<string, unknown> {
  const model = getGroqModel();

  return {
    LOG: false,
    NON_INTERACTIVE_MODE: true,
    API_TIMEOUT_MS: 600000,
    HOST: ROUTER_HOST,
    Providers: [
      {
        name: "groq",
        api_base_url: "https://api.groq.com/openai/v1/chat/completions",
        api_key: process.env.GROQ_API_KEY,
        models: [model],
        transformer: {
          use: [
            ["maxtoken", { max_tokens: 16384 }],
            "groq",
          ],
        },
      },
    ],
    Router: {
      default: `groq,${model}`,
    },
  };
}

export function writeGroqRouterConfig(): void {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(getGroqRouterConfig(), null, 2));
}

function isRouterPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(ROUTER_PORT, ROUTER_HOST, () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => resolve(false));
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function isGroqRouterRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${ROUTER_BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      return true;
    }
  } catch {
    // Fall back to a port check below.
  }

  return isRouterPortOpen();
}

async function waitForRouter(timeoutMs = 15000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isGroqRouterRunning()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Groq router failed to start on port 3456");
}

function getRouterCliPath(): string {
  const localCli = path.join(
    process.cwd(),
    "node_modules",
    "@musistudio",
    "claude-code-router",
    "dist",
    "cli.js"
  );

  if (fs.existsSync(localCli)) {
    return localCli;
  }

  const uiCli = path.join(
    process.cwd(),
    "lovable-ui",
    "node_modules",
    "@musistudio",
    "claude-code-router",
    "dist",
    "cli.js"
  );

  if (fs.existsSync(uiCli)) {
    return uiCli;
  }

  throw new Error(
    "claude-code-router is not installed. Run npm install in lovable-ui."
  );
}

export async function ensureGroqRouterRunning(): Promise<void> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set");
  }

  writeGroqRouterConfig();

  if (await isGroqRouterRunning()) {
    return;
  }

  if (routerProcess && !routerProcess.killed) {
    await waitForRouter();
    return;
  }

  const cliPath = getRouterCliPath();
  routerProcess = spawn(process.execPath, [cliPath, "start"], {
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    },
  });

  routerProcess.on("exit", () => {
    routerProcess = null;
  });

  await waitForRouter();
}

export function getClaudeSdkEnvForGroq(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: ROUTER_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "groq-router",
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  };
}

export async function withGroqRouter<T>(
  fn: () => Promise<T>
): Promise<T> {
  await ensureGroqRouterRunning();

  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  const groqEnv = getClaudeSdkEnvForGroq();
  process.env.ANTHROPIC_BASE_URL = groqEnv.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = groqEnv.ANTHROPIC_API_KEY;

  try {
    return await fn();
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }

    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }
}

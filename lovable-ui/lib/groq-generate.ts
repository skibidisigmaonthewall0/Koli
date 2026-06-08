import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";
const DEFAULT_MODEL = "llama-3.1-8b-instant";
const FALLBACK_MODEL = "llama-3.1-8b-instant";
const MIN_COMPONENT_LINES = 40;

// Qwen free tier TPM is 6000 — our requests need more. Auto-switch.
const LOW_TPM_MODELS = ["qwen"];

function getGroqModel(): string {
  const configured = process.env.GROQ_MODEL || DEFAULT_MODEL;
  if (LOW_TPM_MODELS.some((m) => configured.includes(m))) {
    return FALLBACK_MODEL;
  }
  return configured;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n// ... truncated for token limit ...";
}

function emitAssistantMessage(
  onLog: ((message: string) => void) | undefined,
  content: string
) {
  onLog?.(
    `__CLAUDE_MESSAGE__ ${JSON.stringify({ type: "assistant", content })}`
  );
}

function stripThinkingTags(text: string): string {
  return text.replace(/[\s\S]*?<\/think>/gi, "").trim();
}

function stripCodeFences(text: string): string {
  const withoutThinking = stripThinkingTags(text);
  const fenced = withoutThinking.match(
    /```(?:tsx|typescript|jsx|javascript)?\s*([\s\S]*?)```/
  );
  if (fenced) {
    return fenced[1].trim();
  }
  return withoutThinking.trim();
}

function countLines(code: string): number {
  return code.split("\n").filter((line) => line.trim()).length;
}

function sanitizeCode(
  code: string,
  options: { extraImports?: string[]; defaultExportName?: string }
): string {
  const allowed = new Set([
    "react",
    "react-dom",
    ...(options.extraImports || []),
  ]);

  const cleaned: string[] = [];

  for (const line of code.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("import ")) {
      const match = trimmed.match(/from\s+['"]([^'"]+)['"]/);
      const source = match?.[1];
      if (source && allowed.has(source)) {
        cleaned.push(line);
      }
      continue;
    }

    if (trimmed.includes("next/head") || trimmed.includes("<Head")) {
      continue;
    }

    cleaned.push(line);
  }

  let result = cleaned.join("\n").trim();
  const exportName = options.defaultExportName || "Page";

  if (exportName === "AppContent") {
    result = result.replace(
      /export\s+default\s+function\s+\w+/g,
      "export default function AppContent"
    );
    if (!/export\s+default\s+function\s+AppContent/.test(result)) {
      result = result.replace(
        /export\s+default\s+\w+/g,
        "export default function AppContent"
      );
    }
  } else {
    result = result.replace(
      /export\s+default\s+App\b/g,
      `export default function ${exportName}`
    );
    result = result.replace(/function\s+App\s*\(/g, `function ${exportName}(`);
  }

  return result;
}

function ensureUseClient(code: string): string {
  const withoutDirective = code.replace(/^["']use client["'];\s*/m, "").trim();

  const needsClient =
    withoutDirective.includes("useState") ||
    withoutDirective.includes("useEffect") ||
    withoutDirective.includes("onClick") ||
    withoutDirective.includes("onChange") ||
    withoutDirective.includes("onSubmit");

  if (needsClient) {
    return `"use client";\n\n${withoutDirective}`;
  }
  return withoutDirective;
}

function ensureDefaultExport(code: string, name: string, fallback: string): string {
  if (new RegExp(`export\\s+default\\s+function\\s+${name}`).test(code)) {
    return code;
  }
  if (/export\s+default/.test(code)) {
    return code;
  }
  return `${code}\n\n${fallback}`;
}

function buildPageShell(prompt: string): string {
  const title = prompt.replace(/"/g, "'").slice(0, 60);
  return `import AppContent from "@/components/AppContent";

export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-black text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">${title}</h1>
          <p className="mt-2 text-gray-400">Built with AI</p>
        </header>
        <AppContent />
        <footer className="mt-12 border-t border-gray-800 pt-6 text-center text-sm text-gray-500">
          Generated app
        </footer>
      </div>
    </main>
  );
}`;
}

async function callGroqOnce(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
      signal,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Groq API ${response.status}: ${errorText}`);
    (err as Error & { status: number }).status = response.status;
    throw err;
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;
  const content = message?.content || message?.reasoning || "";

  if (!content) {
    throw new Error("Groq returned an empty response");
  }

  return content;
}

async function callGroq(
  system: string,
  user: string,
  maxTokens: number,
  onLog?: (message: string) => void
): Promise<string> {
  const primaryModel = getGroqModel();
  const configured = process.env.GROQ_MODEL || DEFAULT_MODEL;

  if (LOW_TPM_MODELS.some((m) => configured.includes(m)) && configured !== primaryModel) {
    onLog?.(
      `⚠️ ${configured} has a 6000 TPM limit — using ${primaryModel} instead`
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const heartbeat = setInterval(() => {
    onLog?.("⏳ Still generating code...");
  }, 15000);

  const models = [primaryModel];
  if (!models.includes(FALLBACK_MODEL)) {
    models.push(FALLBACK_MODEL);
  }

  try {
    let lastError: Error | null = null;

    for (const model of models) {
      try {
        return await callGroqOnce(
          model,
          system,
          user,
          maxTokens,
          controller.signal
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const status = (lastError as Error & { status?: number }).status;
        const isTokenLimit =
          status === 413 ||
          lastError.message.includes("rate_limit") ||
          lastError.message.includes("too large") ||
          lastError.message.includes("TPM");

        if (isTokenLimit && model !== FALLBACK_MODEL) {
          onLog?.(`⚠️ Token limit hit on ${model}, retrying with ${FALLBACK_MODEL}...`);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError || new Error("Groq request failed");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Groq API timed out after 2 minutes");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

async function generateComponent(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  emitAssistantMessage(onLog, `Building **${COMPONENT_PATH}**`);
  onLog?.(`✏️ Writing ${COMPONENT_PATH}...`);

  const raw = await callGroq(
    `Write components/AppContent.tsx. Return ONLY raw TSX, no markdown.
"use client"; export default function AppContent(). Import only from "react".
Tailwind dark UI. ${MIN_COMPONENT_LINES}+ lines. Full working logic, no TODOs.`,
    truncateText(`Build: ${prompt}`, 500),
    4096,
    onLog
  );

  let code = stripCodeFences(raw);
  code = sanitizeCode(code, { defaultExportName: "AppContent" });
  code = ensureUseClient(code);
  code = ensureDefaultExport(
    code,
    "AppContent",
    `export default function AppContent() {
  return <div className="p-6 text-white">App content</div>;
}`
  );

  onLog?.(`✓ ${COMPONENT_PATH} (${countLines(code)} lines)`);
  return code;
}

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using model: ${getGroqModel()}`);

  const componentCode = await generateComponent(prompt, onLog);
  const pageCode = buildPageShell(prompt);
  onLog?.(`✓ app/page.tsx (template, ${countLines(pageCode)} lines)`);

  const files = getNextJsScaffold();
  files.push({ path: COMPONENT_PATH, content: componentCode });
  files.push({ path: "app/page.tsx", content: pageCode });

  onLog?.(
    `✓ Done — ${files.length} files, ${countLines(componentCode) + countLines(pageCode)} lines of AI code`
  );
  return files;
}

export interface FollowUpContext {
  originalPrompt: string;
  followUp: string;
  existingComponent: string;
  existingPage: string;
}

export async function generateFollowUpFiles(
  ctx: FollowUpContext,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using model: ${getGroqModel()} for follow-up`);
  emitAssistantMessage(onLog, `Updating: "${ctx.followUp}"`);

  onLog?.(`✏️ Updating ${COMPONENT_PATH}...`);
  const componentRaw = await callGroq(
    `Update AppContent.tsx per follow-up. Return COMPLETE file, raw TSX only.
"use client", export default function AppContent(), react imports only, Tailwind.`,
    truncateText(
      `Original: ${ctx.originalPrompt}\nFollow-up: ${ctx.followUp}\n\nCurrent:\n${ctx.existingComponent}`,
      12000
    ),
    4096,
    onLog
  );

  let componentCode = stripCodeFences(componentRaw);
  componentCode = sanitizeCode(componentCode, { defaultExportName: "AppContent" });
  componentCode = ensureUseClient(componentCode);
  componentCode = ensureDefaultExport(
    componentCode,
    "AppContent",
    ctx.existingComponent
  );
  onLog?.(`✓ Updated ${COMPONENT_PATH} (${countLines(componentCode)} lines)`);

  return [
    { path: COMPONENT_PATH, content: componentCode },
    { path: "app/page.tsx", content: ctx.existingPage },
  ];
}

import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";
const DEFAULT_MODEL = "llama-3.1-8b-instant";
const MIN_COMPONENT_LINES = 30;

/** Groq on_demand free tier: input + max_tokens must stay under ~6000 */
const GROQ_TPM_BUDGET = 5500;

function getGroqModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function budgetMaxTokens(
  system: string,
  user: string,
  desired: number
): number {
  const inputEst = estimateTokens(system) + estimateTokens(user);
  const available = GROQ_TPM_BUDGET - inputEst - 80;
  return Math.max(512, Math.min(desired, available));
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
  if (fenced) return fenced[1].trim();
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
      if (match?.[1] && allowed.has(match[1])) cleaned.push(line);
      continue;
    }
    if (trimmed.includes("next/head") || trimmed.includes("<Head")) continue;
    cleaned.push(line);
  }

  let result = cleaned.join("\n").trim();
  const exportName = options.defaultExportName || "Page";

  if (exportName === "AppContent") {
    result = result.replace(
      /export\s+default\s+function\s+\w+/g,
      "export default function AppContent"
    );
  } else {
    result = result.replace(
      /export\s+default\s+App\b/g,
      `export default function ${exportName}`
    );
  }
  return result;
}

function ensureUseClient(code: string): string {
  const body = code.replace(/^["']use client["'];\s*/m, "").trim();
  const needs =
    body.includes("useState") ||
    body.includes("useEffect") ||
    body.includes("onClick");
  return needs ? `"use client";\n\n${body}` : body;
}

function ensureDefaultExport(code: string, name: string, fallback: string): string {
  if (new RegExp(`export\\s+default\\s+function\\s+${name}`).test(code)) return code;
  if (/export\s+default/.test(code)) return code;
  return `${code}\n\n${fallback}`;
}

function buildPageShell(prompt: string): string {
  const title = prompt.replace(/"/g, "'").slice(0, 60);
  return `import AppContent from "@/components/AppContent";

export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-950 to-black text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold">${title}</h1>
        </header>
        <AppContent />
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
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

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
  const content =
    data.choices?.[0]?.message?.content ||
    data.choices?.[0]?.message?.reasoning ||
    "";
  if (!content) throw new Error("Groq returned an empty response");
  return content;
}

function isTokenLimitError(error: Error): boolean {
  const status = (error as Error & { status?: number }).status;
  return (
    status === 413 ||
    error.message.includes("rate_limit") ||
    error.message.includes("too large") ||
    error.message.includes("TPM")
  );
}

async function callGroq(
  system: string,
  user: string,
  desiredMaxTokens: number,
  onLog?: (message: string) => void
): Promise<string> {
  const model = getGroqModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const heartbeat = setInterval(() => onLog?.("⏳ Still generating..."), 15000);

  let sys = system;
  let usr = user;
  let maxTok = budgetMaxTokens(sys, usr, desiredMaxTokens);

  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await callGroqOnce(model, sys, usr, maxTok, controller.signal);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (!isTokenLimitError(err) || attempt === 3) throw err;

        maxTok = Math.floor(maxTok * 0.6);
        usr = truncateText(usr, Math.floor(usr.length * 0.6));
        sys = truncateText(sys, 200);
        onLog?.(`⚠️ Shrinking request (attempt ${attempt + 2}, max_tokens=${maxTok})...`);
      }
    }
    throw new Error("Groq request failed after retries");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Groq API timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}

const SYSTEM_COMPONENT =
  'Write AppContent.tsx. Raw TSX only. "use client". export default function AppContent(). react imports only. Tailwind.';

async function generateComponent(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  emitAssistantMessage(onLog, `Building **${COMPONENT_PATH}**`);
  onLog?.(`✏️ Writing ${COMPONENT_PATH}...`);

  const userMsg = truncateText(prompt, 300);
  const raw = await callGroq(SYSTEM_COMPONENT, userMsg, 1800, onLog);

  let code = stripCodeFences(raw);
  code = sanitizeCode(code, { defaultExportName: "AppContent" });
  code = ensureUseClient(code);
  code = ensureDefaultExport(
    code,
    "AppContent",
    `export default function AppContent() {
  return <div className="p-6 text-white">Loading...</div>;
}`
  );

  if (countLines(code) < MIN_COMPONENT_LINES) {
    onLog?.("⚠️ Expanding component (2nd pass)...");
    const expanded = await callGroq(
      SYSTEM_COMPONENT,
      truncateText(
        `Expand this component for "${userMsg}". Return COMPLETE file:\n${code}`,
        2500
      ),
      1800,
      onLog
    );
    const more = stripCodeFences(expanded);
    if (countLines(more) > countLines(code)) {
      code = sanitizeCode(more, { defaultExportName: "AppContent" });
      code = ensureUseClient(code);
    }
  }

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
  onLog?.(`✓ app/page.tsx (template)`);

  const files = getNextJsScaffold();
  files.push({ path: COMPONENT_PATH, content: componentCode });
  files.push({ path: "app/page.tsx", content: pageCode });

  onLog?.(`✓ Done — ${files.length} files`);
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

  const snippet = truncateText(ctx.existingComponent, 3500);
  const userMsg = truncateText(
    `Fix: ${ctx.followUp}\n\nFile:\n${snippet}`,
    4000
  );

  onLog?.(`✏️ Updating ${COMPONENT_PATH}...`);
  const componentRaw = await callGroq(
    'Update AppContent.tsx. Return COMPLETE raw TSX. "use client". react only.',
    userMsg,
    1800,
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

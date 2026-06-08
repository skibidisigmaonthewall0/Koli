import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";
const FAST_MODEL = "llama-3.3-70b-versatile";
const MIN_COMPONENT_LINES = 50;

function getCodeModel(): string {
  return process.env.GROQ_CODE_MODEL || process.env.GROQ_MODEL || FAST_MODEL;
}

function getPlanModel(): string {
  return process.env.GROQ_PLAN_MODEL || getCodeModel();
}

function usesReasoning(model: string, enabled?: boolean): boolean {
  if (enabled === false) return false;
  if (enabled === true) return model.includes("qwen");
  return false;
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

async function callGroq(
  system: string,
  user: string,
  maxTokens: number,
  options?: {
    reasoning?: boolean;
    model?: string;
    onLog?: (message: string) => void;
    timeoutMs?: number;
  }
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const model = options?.model || getCodeModel();
  const enableReasoning = usesReasoning(model, options?.reasoning);
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let heartbeatCount = 0;
  const heartbeat = options?.onLog
    ? setInterval(() => {
        heartbeatCount += 1;
        options.onLog?.(`⏳ Still working... (${heartbeatCount * 10}s)`);
      }, 10000)
    : null;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };

  if (enableReasoning) {
    body.reasoning_effort = "low";
  }

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content =
      message?.content ||
      message?.reasoning ||
      "";

    if (!content) {
      throw new Error("Groq returned an empty response");
    }

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Groq API timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function createPlan(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("🧠 Planning the project...");
  emitAssistantMessage(onLog, "Planning your app...");

  const plan = await callGroq(
    `Create a concise project plan for a Next.js app. Sections: Goal, Features, State, UI layout, Visual style. NO code. Max 250 words.`,
    `User request: ${prompt}`,
    600,
    { model: getPlanModel(), reasoning: false, onLog }
  );

  const cleaned = stripThinkingTags(plan);
  emitAssistantMessage(onLog, `**Project plan**\n\n${cleaned}`);
  onLog?.("✓ Project plan ready");
  return cleaned;
}

async function generateComponent(
  prompt: string,
  plan: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.(`✏️ Writing ${COMPONENT_PATH}...`);

  const writeCode = async (extraInstruction = "") => {
    const raw = await callGroq(
      `Write COMPLETE components/AppContent.tsx for Next.js 14.

STRICT RULES:
- Return ONLY raw TSX. No markdown.
- ${MIN_COMPONENT_LINES}+ lines of real code — NOT a stub.
- Start with "use client";
- export default function AppContent()
- ONLY import from "react"
- NO external npm packages
- Tailwind only — polished dark UI, responsive
- Full logic: state, handlers, win/lose, reset where needed
- NO "// TODO" or placeholders`,
      `User request: ${prompt}

Plan:
${plan}
${extraInstruction}`,
      6000,
      { model: getCodeModel(), reasoning: false, onLog }
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
    return code;
  };

  let code = await writeCode();

  if (countLines(code) < MIN_COMPONENT_LINES) {
    onLog?.(`⚠️ Component too short (${countLines(code)} lines) — retrying...`);
    code = await writeCode(
      "\nIMPORTANT: Write a longer, complete implementation (80+ lines)."
    );
  }

  onLog?.(`✓ ${COMPONENT_PATH} written (${countLines(code)} lines)`);
  return code;
}

async function generatePage(
  prompt: string,
  plan: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("✏️ Writing app/page.tsx...");

  const raw = await callGroq(
    `Write app/page.tsx for Next.js 14.

STRICT RULES:
- Return ONLY raw TSX. No markdown.
- export default function Page()
- MUST import AppContent from "@/components/AppContent"
- ONLY imports: "react" and "@/components/AppContent"
- Tailwind — hero header, subtitle, footer, responsive`,
    `User request: ${prompt}

Plan:
${plan}`,
    1500,
    { model: getCodeModel(), reasoning: false, onLog }
  );

  let code = stripCodeFences(raw);
  code = sanitizeCode(code, {
    extraImports: ["@/components/AppContent"],
    defaultExportName: "Page",
  });

  if (!code.includes("@/components/AppContent")) {
    code = `import AppContent from "@/components/AppContent";\n\n${code}`;
  }

  code = ensureDefaultExport(
    code,
    "Page",
    `export default function Page() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 text-white">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">Generated App</h1>
          <p className="mt-2 text-gray-400">Built with AI</p>
        </header>
        <AppContent />
      </div>
    </main>
  );
}`
  );

  onLog?.(`✓ app/page.tsx written (${countLines(code)} lines)`);
  return code;
}

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using model: ${getCodeModel()}`);

  const plan = await createPlan(prompt, onLog);
  const componentCode = await generateComponent(prompt, plan, onLog);
  const pageCode = await generatePage(prompt, plan, onLog);

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

async function generateFollowUpComponent(
  ctx: FollowUpContext,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("🧠 Thinking about your follow-up...");
  emitAssistantMessage(
    onLog,
    `Got it — I'll update the app based on: "${ctx.followUp}"`
  );

  onLog?.(`✏️ Updating ${COMPONENT_PATH}...`);

  const raw = await callGroq(
    `Update an EXISTING Next.js component based on a follow-up request.

STRICT RULES:
- Return COMPLETE updated components/AppContent.tsx (full file, not a diff)
- Return ONLY raw TSX. No markdown.
- Keep "use client" and export default function AppContent()
- ONLY import from "react"
- Fix bugs and apply improvements requested
- Keep working code unchanged where possible
- Tailwind only, polished dark UI`,
    `Original request: ${ctx.originalPrompt}
Follow-up: ${ctx.followUp}

Current file:
${ctx.existingComponent}`,
    6000,
    { model: getCodeModel(), reasoning: false, onLog }
  );

  let code = stripCodeFences(raw);
  code = sanitizeCode(code, { defaultExportName: "AppContent" });
  code = ensureUseClient(code);
  code = ensureDefaultExport(code, "AppContent", ctx.existingComponent);

  onLog?.(`✓ Updated ${COMPONENT_PATH} (${countLines(code)} lines)`);
  return code;
}

async function generateFollowUpPage(
  ctx: FollowUpContext,
  updatedComponent: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("✏️ Updating app/page.tsx if needed...");

  const raw = await callGroq(
    `Update app/page.tsx if the follow-up requires layout/title changes. Otherwise return the existing file with minimal tweaks.

STRICT RULES:
- Return COMPLETE app/page.tsx (full file)
- ONLY imports: react and @/components/AppContent
- export default function Page()
- Tailwind dark theme`,
    `Original: ${ctx.originalPrompt}
Follow-up: ${ctx.followUp}

Current page.tsx:
${ctx.existingPage}

Updated AppContent (for context):
${updatedComponent.slice(0, 3000)}`,
    1500,
    { model: getCodeModel(), reasoning: false, onLog }
  );

  let code = stripCodeFences(raw);
  code = sanitizeCode(code, {
    extraImports: ["@/components/AppContent"],
    defaultExportName: "Page",
  });

  if (!code.includes("@/components/AppContent")) {
    code = `import AppContent from "@/components/AppContent";\n\n${code}`;
  }

  code = ensureDefaultExport(code, "Page", ctx.existingPage);
  onLog?.(`✓ Updated app/page.tsx (${countLines(code)} lines)`);
  return code;
}

export async function generateFollowUpFiles(
  ctx: FollowUpContext,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using model: ${getGroqModel()} for follow-up`);

  const componentCode = await generateFollowUpComponent(ctx, onLog);
  const pageCode = await generateFollowUpPage(ctx, componentCode, onLog);

  return [
    { path: COMPONENT_PATH, content: componentCode },
    { path: "app/page.tsx", content: pageCode },
  ];
}

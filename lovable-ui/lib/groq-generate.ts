import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";
const DEFAULT_MODEL = "qwen/qwen3-32b";
const MIN_COMPONENT_LINES = 100;

function getGroqModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

function usesReasoning(model: string): boolean {
  return model.includes("qwen");
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
  options?: { reasoning?: boolean }
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const model = getGroqModel();
  const enableReasoning = options?.reasoning ?? usesReasoning(model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.3,
  };

  if (enableReasoning) {
    body.reasoning_effort = "default";
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
      throw new Error("Groq API timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function thinkAboutFile(
  fileName: string,
  prompt: string,
  plan: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.(`🧠 Thinking about ${fileName}...`);

  const thoughts = await callGroq(
    `You are a senior React engineer planning ONE file before coding.

Think step-by-step:
1. What this file must do
2. State variables and types needed
3. Helper functions / handlers
4. UI sections and layout (top to bottom)
5. Edge cases and win/lose/error states
6. Tailwind styling approach

NO code. Be detailed and specific. 200-400 words.`,
    `File to plan: ${fileName}\nUser request: ${prompt}\n\nProject plan:\n${plan}`,
    1200,
    { reasoning: true }
  );

  const cleaned = stripThinkingTags(thoughts);
  emitAssistantMessage(onLog, `**Thinking: \`${fileName}\`**\n\n${cleaned}`);
  onLog?.(`✓ Finished thinking about ${fileName}`);
  return cleaned;
}

async function createPlan(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("🧠 Planning the full project...");
  emitAssistantMessage(onLog, "Let me understand your request and plan the architecture...");

  const plan = await callGroq(
    `You are a senior frontend architect. Create a detailed project plan BEFORE any code.

Sections:
## Goal
## User stories (bullets)
## Features (detailed bullets)
## Data & state
## UI layout (every section)
## AppContent component (full behavior spec)
## Page shell
## Visual design (colors, typography, spacing)

NO code. Be thorough. 400-600 words.`,
    `User request: ${prompt}`,
    1500,
    { reasoning: true }
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
  const fileThoughts = await thinkAboutFile(
    COMPONENT_PATH,
    prompt,
    plan,
    onLog
  );

  onLog?.(`✏️ Writing ${COMPONENT_PATH} (full implementation)...`);

  const writeCode = async (extraInstruction = "") => {
    const raw = await callGroq(
      `Write the COMPLETE components/AppContent.tsx for Next.js 14.

STRICT RULES:
- Return ONLY raw TSX. No markdown. No explanation outside code.
- Minimum ${MIN_COMPONENT_LINES}+ lines of real code — NOT a stub.
- Start with "use client";
- export default function AppContent()
- ONLY import from "react" (useState, useEffect, useMemo, useCallback as needed)
- NO external npm packages
- Tailwind className only — polished dark UI, gradients, hover states, responsive
- Include ALL logic: state, handlers, helper functions, sub-components inline if needed
- For games: full rules, win detection, reset, turn indicator, board rendering
- For dashboards: multiple sections with realistic sample data arrays
- NO placeholders, NO "// TODO", NO empty divs`,
      `User request: ${prompt}

Project plan:
${plan}

File-specific thinking:
${fileThoughts}
${extraInstruction}`,
      8000,
      { reasoning: true }
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
    onLog?.(`⚠️ Component too short (${countLines(code)} lines) — expanding...`);
    code = await writeCode(
      "\n\nIMPORTANT: Previous attempt was too short. Write a MUCH longer, complete implementation with at least 150 lines."
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
  const fileThoughts = await thinkAboutFile("app/page.tsx", prompt, plan, onLog);

  onLog?.("✏️ Writing app/page.tsx...");

  const raw = await callGroq(
    `Write app/page.tsx for Next.js 14 app router.

STRICT RULES:
- Return ONLY raw TSX. No markdown.
- At least 40 lines — rich layout, not a bare wrapper
- export default function Page()
- MUST import AppContent from "@/components/AppContent"
- ONLY imports: "react" and "@/components/AppContent"
- Tailwind — hero header, subtitle, stats row or nav, footer, responsive padding
- Match the user request theme`,
    `User request: ${prompt}

Plan:
${plan}

File thinking:
${fileThoughts}`,
    2000,
    { reasoning: true }
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
  onLog?.(`Using model: ${getGroqModel()}`);

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

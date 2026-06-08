import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";

function getGroqModel(): string {
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

function emitAssistantMessage(onLog: ((message: string) => void) | undefined, content: string) {
  onLog?.(
    `__CLAUDE_MESSAGE__ ${JSON.stringify({ type: "assistant", content })}`
  );
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:tsx|typescript|jsx|javascript)?\s*([\s\S]*?)```/);
  if (fenced) {
    return fenced[1].trim();
  }
  return text.trim();
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
    result = result.replace(/export\s+default\s+function\s+\w+/g, "export default function AppContent");
    if (!/export\s+default\s+function\s+AppContent/.test(result)) {
      result = result.replace(/export\s+default\s+\w+/g, "export default function AppContent");
    }
  } else {
    result = result.replace(/export\s+default\s+App\b/g, `export default function ${exportName}`);
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
  maxTokens: number
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const model = getGroqModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  try {
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
          temperature: 0.35,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

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

async function createPlan(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("🧠 Thinking about your request...");
  emitAssistantMessage(onLog, "Let me plan this before writing any code...");

  const plan = await callGroq(
    `You are a senior frontend engineer. Plan a Next.js app BEFORE coding.

Output a clear plan with these sections:
## Goal
## Features (bullets)
## Layout (header, main, sections)
## Component: AppContent (what it does, state, interactions)
## Page shell (what app/page.tsx wraps)
## Polish (colors, responsive, UX details)

Rules: NO code. Be specific and practical. Under 350 words.`,
    `User request: ${prompt}`,
    900
  );

  emitAssistantMessage(onLog, `**Plan**\n\n${plan.trim()}`);
  onLog?.("✓ Plan ready — starting implementation");
  return plan.trim();
}

async function generateComponent(
  prompt: string,
  plan: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("✏️ Writing main component (components/AppContent.tsx)...");

  const raw = await callGroq(
    `Write components/AppContent.tsx for Next.js 14.

STRICT RULES:
- Return ONLY raw TSX. No markdown. No explanation.
- Start with "use client";
- export default function AppContent()
- ONLY import from "react"
- NO npm packages (no marked, axios, next/head, etc.)
- Tailwind className only — make it look polished (dark theme, spacing, rounded cards)
- Implement ALL interactive logic here (games, forms, state, etc.)
- Complete working code — no placeholders or TODOs`,
    `User request: ${prompt}\n\nPlan to follow:\n${plan}`,
    2200
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

  onLog?.("✓ Main component written");
  return code;
}

async function generatePage(
  prompt: string,
  plan: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("✏️ Writing page shell (app/page.tsx)...");

  const raw = await callGroq(
    `Write app/page.tsx for Next.js 14 app router.

STRICT RULES:
- Return ONLY raw TSX. No markdown. No explanation.
- export default function Page()
- MUST import AppContent from "@/components/AppContent"
- ONLY imports allowed: "react" and "@/components/AppContent"
- Tailwind only — full-screen dark layout, title, padding, centered content
- Page is a shell — put minimal logic here, main UI is in AppContent`,
    `User request: ${prompt}\n\nPlan:\n${plan}`,
    800
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
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="mb-8 text-3xl font-bold">Generated App</h1>
        <AppContent />
      </div>
    </main>
  );
}`
  );

  onLog?.("✓ Page shell written");
  return code;
}

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using Groq model: ${getGroqModel()}`);

  const plan = await createPlan(prompt, onLog);
  const componentCode = await generateComponent(prompt, plan, onLog);
  const pageCode = await generatePage(prompt, plan, onLog);

  const files = getNextJsScaffold();
  files.push({ path: COMPONENT_PATH, content: componentCode });
  files.push({ path: "app/page.tsx", content: pageCode });

  onLog?.(`✓ Done — ${files.length} files (${files.length - getNextJsScaffold().length} written by AI)`);
  return files;
}

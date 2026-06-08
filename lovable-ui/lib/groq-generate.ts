import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

const COMPONENT_PATH = "components/AppContent.tsx";
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const MIN_COMPONENT_LINES = 40;

function getGroqModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
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
  onLog?: (message: string) => void
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const model = getGroqModel();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  const heartbeat = setInterval(() => {
    onLog?.("⏳ Still generating code...");
  }, 15000);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.4,
  };

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
  emitAssistantMessage(
    onLog,
    `Building **${COMPONENT_PATH}** for: "${prompt}"`
  );
  onLog?.(`✏️ Writing ${COMPONENT_PATH}...`);

  const raw = await callGroq(
    `Write the COMPLETE components/AppContent.tsx for Next.js 14.

STRICT RULES:
- Return ONLY raw TSX. No markdown. No explanation.
- At least ${MIN_COMPONENT_LINES}+ lines of real working code.
- Start with "use client";
- export default function AppContent()
- ONLY import from "react"
- NO external npm packages
- Tailwind className only — polished dark UI
- For games: full rules, win detection, reset, board
- NO placeholders, NO "// TODO"`,
    `Build this: ${prompt}`,
    6000,
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

async function generatePage(
  prompt: string,
  onLog?: (message: string) => void
): Promise<string> {
  onLog?.("✏️ Writing app/page.tsx...");

  const raw = await callGroq(
    `Write app/page.tsx for Next.js 14 app router.

STRICT RULES:
- Return ONLY raw TSX. No markdown.
- At least 30 lines
- export default function Page()
- MUST import AppContent from "@/components/AppContent"
- ONLY imports: "react" and "@/components/AppContent"
- Tailwind dark theme layout with header and footer`,
    `Build a page shell for: ${prompt}`,
    1500,
    onLog
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
        <AppContent />
      </div>
    </main>
  );
}`
  );

  onLog?.(`✓ app/page.tsx (${countLines(code)} lines)`);
  return code;
}

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Using model: ${getGroqModel()}`);

  const componentCode = await generateComponent(prompt, onLog);
  const pageCode = await generatePage(prompt, onLog);

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
  emitAssistantMessage(
    onLog,
    `Updating the app: "${ctx.followUp}"`
  );

  onLog?.(`✏️ Updating ${COMPONENT_PATH}...`);
  const componentRaw = await callGroq(
    `Update the EXISTING components/AppContent.tsx based on the follow-up request.
Return the COMPLETE updated file. ONLY raw TSX. "use client". export default function AppContent().
ONLY import from "react". Tailwind only. NO external packages.`,
    `Original: ${ctx.originalPrompt}
Follow-up: ${ctx.followUp}

Current file:
${ctx.existingComponent}`,
    6000,
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

  onLog?.("✏️ Updating app/page.tsx if needed...");
  const pageRaw = await callGroq(
    `Update app/page.tsx if needed for the follow-up. Return COMPLETE file.
ONLY imports: react and @/components/AppContent. export default function Page().`,
    `Follow-up: ${ctx.followUp}
Current page:
${ctx.existingPage}`,
    1500,
    onLog
  );

  let pageCode = stripCodeFences(pageRaw);
  pageCode = sanitizeCode(pageCode, {
    extraImports: ["@/components/AppContent"],
    defaultExportName: "Page",
  });
  if (!pageCode.includes("@/components/AppContent")) {
    pageCode = `import AppContent from "@/components/AppContent";\n\n${pageCode}`;
  }
  pageCode = ensureDefaultExport(pageCode, "Page", ctx.existingPage);
  onLog?.(`✓ Updated app/page.tsx (${countLines(pageCode)} lines)`);

  return [
    { path: COMPONENT_PATH, content: componentCode },
    { path: "app/page.tsx", content: pageCode },
  ];
}

import { getNextJsScaffold } from "./nextjs-scaffold";

export interface GeneratedFile {
  path: string;
  content: string;
}

function getGroqModel(): string {
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:tsx|typescript|jsx|javascript)?\s*([\s\S]*?)```/);
  if (fenced) {
    return fenced[1].trim();
  }
  return text.trim();
}

const ALLOWED_IMPORT_SOURCES = new Set(["react", "react-dom"]);

function sanitizePageCode(code: string): string {
  const lines = code.split("\n");
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("import ")) {
      const match = trimmed.match(/from\s+['"]([^'"]+)['"]/);
      const source = match?.[1];
      if (source && ALLOWED_IMPORT_SOURCES.has(source)) {
        cleaned.push(line);
      }
      continue;
    }

    if (trimmed.includes("next/head") || trimmed.includes("<Head")) {
      continue;
    }

    cleaned.push(line);
  }

  let result = cleaned.join("\n");
  result = result.replace(/export\s+default\s+App\b/g, "export default function Page");
  result = result.replace(/function\s+App\s*\(/g, "function Page(");
  result = result.replace(/const\s+App\s*=/g, "const Page =");

  return result.trim();
}

function ensureUseClient(code: string): string {
  const withoutDirective = code
    .replace(/^["']use client["'];\s*/m, "")
    .trim();

  const needsClient =
    withoutDirective.includes("useState") ||
    withoutDirective.includes("useEffect") ||
    withoutDirective.includes("onClick") ||
    withoutDirective.includes("onChange");

  if (needsClient) {
    return `"use client";\n\n${withoutDirective}`;
  }
  return withoutDirective;
}

function ensureDefaultExport(code: string): string {
  if (/export\s+default\s+function\s+Page/.test(code)) {
    return code;
  }
  if (/export\s+default/.test(code)) {
    return code;
  }
  return `${code}\n\nexport default function Page() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-bold text-white">Generated App</h1>
    </main>
  );
}\n`;
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
          temperature: 0.4,
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

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  onLog?.(`Calling Groq (${getGroqModel()}) for page code only...`);

  const system = `You write a single Next.js 14 app/page.tsx file.

STRICT RULES:
- Return ONLY raw TSX code. No markdown fences. No explanation.
- ONLY import from "react" (useState, useEffect, etc). NO other imports.
- NEVER use: marked, axios, next/head, next/router, or any npm package.
- Use Tailwind CSS className for all styling.
- Use "use client" at the top if the page has buttons, games, or state.
- Must end with: export default function Page() { ... }
- Put all UI in one file. Use inline data/constants instead of fetching external libs.`;

  const user = `Build this as one self-contained page:\n${prompt}`;

  const raw = await callGroq(system, user, 1500);
  onLog?.("Groq response received");

  let pageCode = stripCodeFences(raw);
  pageCode = sanitizePageCode(pageCode);
  pageCode = ensureUseClient(pageCode);
  pageCode = ensureDefaultExport(pageCode);

  const files = getNextJsScaffold();
  files.push({ path: "app/page.tsx", content: pageCode });

  onLog?.(`Ready: ${files.length} files (1 from Groq, rest from template)`);
  return files;
}

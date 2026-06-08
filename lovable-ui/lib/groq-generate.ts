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

function ensureUseClient(code: string): string {
  if (code.includes('"use client"') || code.includes("'use client'")) {
    return code;
  }
  if (
    code.includes("useState") ||
    code.includes("useEffect") ||
    code.includes("onClick")
  ) {
    return `"use client";\n\n${code}`;
  }
  return code;
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

  const system =
    "You write React/Next.js page components. Return ONLY the TypeScript/TSX code for app/page.tsx. No markdown fences. No explanation. Use Tailwind CSS classes. Add 'use client' if the page needs interactivity.";

  const user = `Build this as a single Next.js page component:\n${prompt}`;

  const raw = await callGroq(system, user, 1500);
  onLog?.("Groq response received");

  let pageCode = ensureUseClient(stripCodeFences(raw));

  if (!pageCode.includes("export default")) {
    pageCode = `${pageCode}\n\nexport default function Page() {\n  return <main className="p-8"><h1 className="text-2xl font-bold">Generated</h1></main>;\n}\n`;
  }

  const files = getNextJsScaffold();
  files.push({ path: "app/page.tsx", content: pageCode });

  onLog?.(`Ready: ${files.length} files (1 from Groq, rest from template)`);
  return files;
}

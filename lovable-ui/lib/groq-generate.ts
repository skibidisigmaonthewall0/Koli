export interface GeneratedFile {
  path: string;
  content: string;
}

function getGroqModel(): string {
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

const SYSTEM_PROMPT = `You are an expert web developer. Return ONLY valid JSON with this exact shape:
{"files":[{"path":"package.json","content":"..."},{"path":"app/page.tsx","content":"..."}]}

Rules:
- Create a complete Next.js 14 app (app router) with TypeScript and Tailwind CSS.
- Always include: package.json, next.config.mjs, tsconfig.json, postcss.config.mjs, tailwind.config.ts, app/layout.tsx, app/page.tsx, app/globals.css.
- package.json must have scripts dev/build/start and dependencies next, react, react-dom, typescript, tailwindcss, postcss, autoprefixer, @types/react, @types/node.
- For games or interactive UIs, use a client component in app/page.tsx with "use client".
- Match the user request closely. Keep files minimal but working.
- Escape newlines properly inside JSON strings. No markdown fences.`;

export async function generateFilesWithGroq(
  prompt: string,
  onLog?: (message: string) => void
): Promise<GeneratedFile[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const model = getGroqModel();
  onLog?.(`Calling Groq API (${model})...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          max_tokens: 8000,
          temperature: 0.3,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Groq API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("Groq returned an empty response");
    }

    onLog?.("Groq response received, parsing files...");

    const parsed = JSON.parse(content) as { files?: GeneratedFile[] };
    if (!parsed.files?.length) {
      throw new Error("Groq response did not include any files");
    }

    onLog?.(`Got ${parsed.files.length} files from Groq`);
    return parsed.files;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Groq API timed out after 120 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

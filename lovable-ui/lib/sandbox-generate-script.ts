export function buildSandboxGenerateScript(): string {
  return `import fs from "fs";
import path from "path";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const userPrompt = Buffer.from(process.env.USER_PROMPT_B64 || "", "base64").toString("utf8");

if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY is missing");
  process.exit(1);
}

async function callGroq(messages) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + GROQ_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 8000,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error("Groq API error: " + (await response.text()));
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function parseFiles(text) {
  const cleaned = text.trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed.files || !Array.isArray(parsed.files)) {
    throw new Error("Groq response missing files array");
  }
  return parsed.files;
}

function writeFiles(files) {
  for (const file of files) {
    if (!file.path || typeof file.content !== "string") {
      continue;
    }
    const filePath = path.join(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
    console.log("__TOOL_USE__", JSON.stringify({
      type: "tool_use",
      name: "Write",
      input: { file_path: file.path },
    }));
    console.log("Wrote " + file.path);
  }
}

async function main() {
  console.log("Calling Groq (" + GROQ_MODEL + ") to generate website...");
  console.log("__CLAUDE_MESSAGE__", JSON.stringify({
    type: "assistant",
    content: "Generating files for: " + userPrompt,
  }));

  const systemPrompt = [
    "You are an expert Next.js developer.",
    "Return ONLY valid JSON with this exact shape:",
    '{"files":[{"path":"package.json","content":"..."},{"path":"app/page.tsx","content":"..."}]}',
    "Create a complete Next.js 14 app using the app router, TypeScript, and Tailwind CSS.",
    "Required files: package.json, next.config.mjs, tsconfig.json, postcss.config.mjs, tailwind.config.ts, app/layout.tsx, app/page.tsx, app/globals.css.",
    "package.json must include scripts: dev, build, start and dependencies: next, react, react-dom, typescript, tailwindcss, postcss, autoprefixer.",
    "Make the UI modern, responsive, and match the user request.",
    "Use plain strings in JSON (escape newlines properly). No markdown fences.",
  ].join(" ");

  const content = await callGroq([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  console.log("__CLAUDE_MESSAGE__", JSON.stringify({
    type: "assistant",
    content: content.slice(0, 300) + (content.length > 300 ? "..." : ""),
  }));

  const files = parseFiles(content);
  writeFiles(files);
  console.log("Generated " + files.length + " files");
}

main().catch((error) => {
  console.error("Generation error:", error);
  process.exit(1);
});
`;
}

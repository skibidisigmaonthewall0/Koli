import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

async function loadGenerator() {
  try {
    return await import("@/lib/daytona-generate");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load Daytona SDK";
    throw new Error(`Server setup error: ${message}`);
  }
}

export async function GET() {
  const hasKeys = Boolean(
    process.env.DAYTONA_API_KEY && process.env.GROQ_API_KEY
  );

  return Response.json({
    ok: hasKeys,
    hasDaytonaKey: Boolean(process.env.DAYTONA_API_KEY),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return Response.json({ error: "Prompt is required" }, { status: 400 });
    }

    if (!process.env.DAYTONA_API_KEY || !process.env.GROQ_API_KEY) {
      return Response.json(
        {
          error:
            "Missing API keys. Add DAYTONA_API_KEY and GROQ_API_KEY in Vercel → Settings → Environment Variables, then redeploy.",
        },
        { status: 500 }
      );
    }

    const { generateWebsiteInDaytona } = await loadGenerator();

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    (async () => {
      try {
        let sandboxId = "";
        let previewUrl = "";

        const result = await generateWebsiteInDaytona({
          prompt,
          onLog: async (line) => {
            if (line.includes("__CLAUDE_MESSAGE__")) {
              const jsonStart =
                line.indexOf("__CLAUDE_MESSAGE__") + "__CLAUDE_MESSAGE__".length;
              try {
                const message = JSON.parse(line.substring(jsonStart).trim());
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "claude_message",
                      content: message.content,
                    })}\n\n`
                  )
                );
              } catch {
                // Ignore parse errors
              }
              return;
            }

            if (line.includes("__TOOL_USE__")) {
              const jsonStart =
                line.indexOf("__TOOL_USE__") + "__TOOL_USE__".length;
              try {
                const toolUse = JSON.parse(line.substring(jsonStart).trim());
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "tool_use",
                      name: toolUse.name,
                      input: toolUse.input,
                    })}\n\n`
                  )
                );
              } catch {
                // Ignore parse errors
              }
              return;
            }

            if (
              line.trim() &&
              !line.includes("[Claude]:") &&
              !line.includes("[Tool]:") &&
              !line.includes("__")
            ) {
              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "progress",
                    message: line.trim(),
                  })}\n\n`
                )
              );

              const sandboxMatch = line.match(/Sandbox created: ([a-f0-9-]+)/);
              if (sandboxMatch) {
                sandboxId = sandboxMatch[1];
              }

              const previewMatch = line.match(/Preview URL: (https:\/\/\S+)/);
              if (previewMatch) {
                previewUrl = previewMatch[1];
              }
            }
          },
        });

        sandboxId = result.sandboxId;
        previewUrl = result.previewUrl;

        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "complete",
              sandboxId,
              previewUrl,
            })}\n\n`
          )
        );
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Generation failed";
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", message })}\n\n`
          )
        );
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } finally {
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}

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

function createLogHandler(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
) {
  return async (line: string) => {
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
    }
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, followUp, sandboxId, originalPrompt } = body;

    const isFollowUp = Boolean(followUp && sandboxId);

    if (!isFollowUp && !prompt) {
      return Response.json({ error: "Prompt is required" }, { status: 400 });
    }

    if (isFollowUp && !originalPrompt) {
      return Response.json(
        { error: "originalPrompt is required for follow-ups" },
        { status: 400 }
      );
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

    const { generateWebsiteInDaytona, iterateWebsiteInDaytona } =
      await loadGenerator();

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    const sendHeartbeat = setInterval(async () => {
      try {
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: "heartbeat" })}\n\n`
          )
        );
      } catch {
        clearInterval(sendHeartbeat);
      }
    }, 10000);

    (async () => {
      try {
        const onLog = createLogHandler(writer, encoder);

        const result = isFollowUp
          ? await iterateWebsiteInDaytona({
              sandboxId,
              originalPrompt,
              followUp,
              onLog,
            })
          : await generateWebsiteInDaytona({
              prompt,
              onLog,
              onSandboxReady: async (id) => {
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "sandbox_ready",
                      sandboxId: id,
                    })}\n\n`
                  )
                );
              },
            });

        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "complete",
              sandboxId: result.sandboxId,
              previewUrl: result.previewUrl,
              files: result.files,
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
        clearInterval(sendHeartbeat);
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

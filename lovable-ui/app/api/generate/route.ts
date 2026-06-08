import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  return new Response(
    JSON.stringify({
      error:
        "Local code generation is not supported on Windows. Use the main app flow at /generate, which runs generation in a Daytona Linux sandbox.",
    }),
    { status: 501, headers: { "Content-Type": "application/json" } }
  );
}

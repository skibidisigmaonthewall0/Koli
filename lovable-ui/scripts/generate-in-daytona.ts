import * as dotenv from "dotenv";
import * as path from "path";
import { generateWebsiteInDaytona } from "../lib/daytona-generate";

dotenv.config({ path: path.join(__dirname, "../../.env") });

async function main() {
  const args = process.argv.slice(2);
  let sandboxId: string | undefined;
  let prompt: string | undefined;

  if (args.length > 0) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(args[0])) {
      sandboxId = args[0];
      prompt = args.slice(1).join(" ");
    } else {
      prompt = args.join(" ");
    }
  }

  if (!prompt) {
    prompt =
      "Create a modern blog website with markdown support and a dark theme. Include a home page, blog listing page, and individual blog post pages.";
  }

  await generateWebsiteInDaytona({ sandboxId, prompt });
}

main().catch((error) => {
  console.error("Failed to generate website:", error);
  process.exit(1);
});

import { type SDKMessage } from "./sdk-types";

export interface CodeGenerationResult {
  success: boolean;
  messages: SDKMessage[];
  error?: string;
}

export async function generateCodeWithClaude(
  _prompt: string
): Promise<CodeGenerationResult> {
  return {
    success: false,
    messages: [],
    error:
      "Local Claude Code generation is not available in the UI package on Windows. Use the Daytona sandbox flow instead.",
  };
}

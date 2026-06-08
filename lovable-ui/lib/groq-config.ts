function getGroqModel(): string {
  return process.env.GROQ_MODEL || "llama-3.1-8b-instant";
}

export function getGroqRouterConfig(): Record<string, unknown> {
  const model = getGroqModel();

  return {
    LOG: false,
    NON_INTERACTIVE_MODE: true,
    API_TIMEOUT_MS: 600000,
    HOST: "127.0.0.1",
    Providers: [
      {
        name: "groq",
        api_base_url: "https://api.groq.com/openai/v1/chat/completions",
        api_key: process.env.GROQ_API_KEY,
        models: [model],
        transformer: {
          use: [
            ["maxtoken", { max_tokens: 16384 }],
            "groq",
          ],
        },
      },
    ],
    Router: {
      default: `groq,${model}`,
    },
  };
}

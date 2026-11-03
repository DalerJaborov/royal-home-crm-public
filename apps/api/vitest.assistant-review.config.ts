// Offline assistant regression suite. No .env, shared setup, database or live providers.
export default {
  envDir: false,
  test: {
    environment: "node",
    setupFiles: [],
    include: [
      "tests/assistant-language-routing.unit.test.ts",
      "tests/assistant-gemini-guards.unit.test.ts",
      "tests/assistant-knowledge.unit.test.ts",
      "tests/assistant-reply.unit.test.ts",
      "tests/assistant-voice.unit.test.ts",
      "tests/assistant-fast-path.unit.test.ts",
    ],
  },
};

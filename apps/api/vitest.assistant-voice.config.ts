// Isolated transport/provider mocks: no .env, database setup or paid API calls.
export default {
  envDir: false,
  test: {
    environment: "node",
    setupFiles: [],
    include: ["tests/assistant-reply.unit.test.ts", "tests/assistant-voice.unit.test.ts"],
  },
};

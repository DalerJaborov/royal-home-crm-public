// Pure module tests only: no .env, provider calls or database setup.
export default {
  envDir: false,
  test: { environment: "node", setupFiles: [], include: ["tests/assistant-knowledge.unit.test.ts"] },
};

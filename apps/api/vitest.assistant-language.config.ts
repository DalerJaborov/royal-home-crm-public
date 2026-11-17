// Isolated pure tests: never load .env, database setup or provider clients.
export default {
  envDir: false,
  test: { environment: "node", setupFiles: [], include: ["tests/assistant-language-routing.unit.test.ts"] },
};

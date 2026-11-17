// Opt-in: the check file rejects every DB except the isolated localhost:15687 test DB.
export default {
  envDir: false,
  test: { environment: "node", setupFiles: [], include: ["tests/assistant-knowledge.db.check.ts"] },
};

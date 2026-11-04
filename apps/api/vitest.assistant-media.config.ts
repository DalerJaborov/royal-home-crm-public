// No DB, .env loading or provider calls. Provider and local binary boundaries are mocked.
export default { envDir: false, test: { environment: "node", setupFiles: [], include: ["tests/assistant-media.unit.test.ts", "tests/assistant-media-telegram.unit.test.ts", "tests/assistant-media-probe.unit.test.ts"] } };

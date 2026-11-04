// Explicit local capability check: requires installed ffprobe and pdfinfo, never a provider/DB.
export default { envDir: false, test: { environment: "node", setupFiles: [], include: ["tests/assistant-media-probe.real.test.ts"] } };

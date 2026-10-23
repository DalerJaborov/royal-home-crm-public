// Local HTTP fixture only. Deliberately does not import index.ts/cron/worker.
import { pinTestEnv } from "./testEnvPin.js";

const target = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" || target.port !== "15439" || target.pathname !== "/audit_web") {
  throw new Error("Night audit HTTP fixture requires the explicitly isolated loopback audit_web database");
}
if (process.env.NODE_ENV === "production" || process.env.LOGIN_CODE_DEV_ECHO !== "1") {
  throw new Error("Night audit fixture requires non-production code-login echo");
}
pinTestEnv(process.env);
const { app } = await import("../src/app.js");
const server = app.listen(4805, "127.0.0.1", () => console.log("Isolated night-audit HTTP fixture ready"));
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

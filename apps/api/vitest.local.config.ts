import { mergeConfig } from "vitest/config";
import base from "./vitest.config.js";
import path from "node:path";

export default mergeConfig(base, {
  resolve: { alias: { "@royal-home/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts") } },
});

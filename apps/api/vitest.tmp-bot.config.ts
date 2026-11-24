import { defineConfig, mergeConfig } from "vitest/config";
import path from "node:path";
import base from "./vitest.config.js";
export default mergeConfig(base, defineConfig({
  resolve: { alias: { "@royal-home/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts") } },
}));

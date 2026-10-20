import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every literal in-app link must land on a route declared in App.tsx.
 * Found 18.10.2026: the pult's «+ Клиент» pointed at `/clients/new`, which
 * matched `clients/:id` and opened a 404 card instead of the create form.
 * Neither the build nor the types can see that, so the guard reads the source;
 * a plain word in an `:id` slot (`new`, `create`) counts as a missing route.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function routePatterns(): RegExp[] {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  return [...app.matchAll(/path="([^"]+)"/g)]
    .map((match) => match[1].replace(/^\//, ""))
    .filter((path) => path !== "*")
    .map((path) => new RegExp(`^${path.split("/").map((part) => part === ":id" ? "(?![a-z-]+$)[^/]+" : part.startsWith(":") ? "[^/]+" : part === "*" ? ".*" : escape(part)).join("/")}$`));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("in-app link targets", () => {
  it("every literal to=/href=/navigate() path matches a declared route", () => {
    const patterns = routePatterns();
    const exists = (target: string) => {
      const path = target.split(/[?#]/)[0].replace(/^\//, "");
      return path === "" || patterns.some((pattern) => pattern.test(path));
    };
    const broken: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      const links = [
        ...[...text.matchAll(/\b(?:to|href)=\{?["'`](\/[^"'`$]*)["'`]/g)].map((match) => match[1]),
        ...[...text.matchAll(/navigate\(\s*["'`](\/[^"'`$]*)["'`]/g)].map((match) => match[1]),
      ];
      for (const link of links) {
        if (link.startsWith("/api") || link.startsWith("//") || /\.\w+$/.test(link.split(/[?#]/)[0])) continue;
        if (!exists(link)) broken.push(`${relative(SRC, file)}: ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

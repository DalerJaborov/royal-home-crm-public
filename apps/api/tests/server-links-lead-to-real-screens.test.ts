import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ССЫЛКИ ИЗ ПУШЕЙ И УВЕДОМЛЕНИЙ ВЕДУТ НА НАСТОЯЩИЕ ЭКРАНЫ (23.09.2026, аудит №16).
 *
 * Сервер пишет адреса экранов строками (`url: "/agents"`), а экраны объявлены в
 * apps/web/src/App.tsx — сборка их между собой не сверяет. Найдено четыре
 * адреса, которых в приложении нет: `/deals/<id>` (салют команде за сделку,
 * вопрос об отзыве), `/agents` (заморозка агента), `/insights/<id>` (диджест
 * инсайтов), `/sellers/<id>` (пульт: приёмка без объекта) — нажатие открывало
 * «страница не найдена». Сторож сверяет каждый такой адрес со списком экранов.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.join(here, "../src");
const APP_TSX = path.join(here, "../../web/src/App.tsx");

function routePatterns(): RegExp[] {
  const app = fs.readFileSync(APP_TSX, "utf8");
  const paths = [...app.matchAll(/path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "*");
  return paths.map((p) => {
    const clean = p.replace(/^\//, "");
    const re = clean
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    return new RegExp(`^/${re}$`);
  });
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "generated") out.push(...sourceFiles(full));
    } else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `url: "/x"`, `href: \`/x/${id}\``, `const url = \`/x\`` — адреса экранов, а не API и не файлов. */
const LINK_RE = /\b(?:url|href)\s*[:=]\s*[`"'](\/[^`"'\s]*)[`"']/g;

describe("Адреса экранов в пушах и уведомлениях", () => {
  it("каждый ведёт на экран, который есть в приложении", () => {
    const patterns = routePatterns();
    expect(patterns.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(LINK_RE)) {
        const raw = m[1];
        // Файлы и адреса API, а не экраны: /api/…, /uploads/…, голосовая заметка
        // (/me/voice-notes/… — путь API, к нему сайт сам добавляет /api/v1).
        if (/^\/(api|uploads)\//.test(raw) || raw.startsWith("/me/voice-notes/") || raw === "/") continue;
        const pathOnly = raw.replace(/\$\{[^}]*\}/g, "X").split(/[?#]/)[0].replace(/\/$/, "");
        if (!pathOnly || pathOnly === "") continue;
        if (!patterns.some((re) => re.test(pathOnly))) bad.push(`${path.relative(API_SRC, file)}: ${raw}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

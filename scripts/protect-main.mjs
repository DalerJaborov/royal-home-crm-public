#!/usr/bin/env node
/**
 * ЗАЩИТА `main` ПОД КОМАНДУ ВЫКАТА — настройки одним файлом.
 *
 *   npm run protect:main              # показать, что будет включено (ничего не меняет)
 *   npm run protect:main -- --apply   # включить (нужен доступ владельца: gh auth login)
 *
 * Включать — только по слову владельца (решение Dan). Разбор каждого пункта —
 * docs/ship.md, раздел «Защита main».
 *
 * Суть (выбор Dan 24.09): отметку «проверено» проверяет СЕРВЕР выката
 * (ops/auto-deploy.sh, строка Ship-Verified в коммите) — облачные сессии Claude
 * ставить статусы GitHub не могут (прокси, 403), и обязательная проверка GitHub
 * закрыла бы им main насовсем. Поэтому GitHub здесь держит остальное: в main
 * только через правку и только squash, без push мимо правки, без переписывания
 * истории и без исключений, включая владельца (снять защиту на время — можно,
 * это видно в настройках).
 *
 * Обязательные проверки GitHub Actions (ci.yml) сюда тоже НЕ входят: с 22.09.2026
 * GitHub их не запускает.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseRepo } from "./ship.mjs";

export function protectionPayload() {
  return {
    // Обязательных проверок нет намеренно — см. шапку: «проверено» сторожит сервер.
    required_status_checks: null,
    // Правила действуют и на администратора: без этого владелец (и любой его
    // токен, включая Claude Code на ноутбуке) вливает мимо отметки одной кнопкой.
    enforce_admins: true,
    // Только через правку; одобрение человеком не требуется — проверяет машина.
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    },
    restrictions: null,
    // Одна правка — один коммит в main (squash): откат одной командой.
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const payload = protectionPayload();
  const url = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim();
  const { owner, repo } = parseRepo(url);
  console.log(`Защита main в ${owner}/${repo}:`);
  console.log(JSON.stringify(payload, null, 2));
  if (!apply) {
    console.log("\nНичего не изменено. Включить: npm run protect:main -- --apply");
    return 0;
  }
  const token =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    (spawnSync("gh", ["auth", "token"], { encoding: "utf8", shell: process.platform === "win32" }).stdout || "").trim();
  if (!token) throw new Error("нет доступа к GitHub: gh auth login");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/main/protection`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}: ${text}`);
  console.log("\nЗащита включена.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✘ ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}

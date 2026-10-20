#!/usr/bin/env node
/**
 * Git-хук pre-push: В `main` ПУШИТ ТОЛЬКО ТО, ЧТО ВЫКАТИТ СЕРВЕР.
 *
 * Сервер (ops/auto-deploy.sh, crm_ship_verified) выкатывает только вершину
 * `main`, у которой в сообщении есть `Ship-Verified: tree=<дерево>` и дерево
 * совпадает. Такую вершину делает только `npm run ship` — и делает её вливанием
 * через GitHub, а не `git push`. Значит любой `git push` в `main` с компьютера —
 * это правка мимо проверки: на сайт она не попадёт, а `main` для всех веток
 * станет красным (так было 25.09, 28.09 и 02.10). Хук пропускает push в `main`
 * только с той же строкой и тем же деревом, что требует сервер, — правило одно.
 *
 * Работает и для людей, и для любого чата Claude Code: подключается
 * `git config core.hooksPath .githooks` (делает SessionStart-хук
 * `.claude/hooks/install-git-hooks.mjs`).
 * Вход git: строки «<local ref> <local sha> <remote ref> <remote sha>».
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function shipVerified(message, tree) {
  const m = /^Ship-Verified: tree=([0-9a-f]{40})\b/m.exec(message || "");
  return Boolean(m && m[1] === tree);
}

export const PUBLIC_HISTORY_ROOT = "0c6887d5993e0bae3fae125d27d6ad2525ec47bb";

export function publicHistoryProblem(remoteUrl, roots) {
  if (!/(?:[:/])DalerJaborov\/royal-home-crm-public(?:\.git)?\/?$/i.test(remoteUrl || "")) return null;
  if (roots?.trim() === PUBLIC_HISTORY_ROOT) return null;
  return "ОСТАНОВЛЕНО: в публичный CRM нельзя отправлять приватную или смешанную историю. Перенеси очищенный diff на ветку от нового origin/main.";
}

function main() {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  for (const line of stdin.split(/\r?\n/)) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (localSha && !/^0+$/.test(localSha)) {
      let roots = "";
      try { roots = git("rev-list", "--max-parents=0", localSha); } catch { /* fail closed for public pushes */ }
      const problem = publicHistoryProblem(process.argv[3], roots);
      if (problem) { console.error(problem); process.exit(1); }
    }
    if (remoteRef !== "refs/heads/main") continue;
    if (/^0+$/.test(localSha || "")) {
      console.error("ОСТАНОВЛЕНО: удалять main нельзя.");
      process.exit(1);
    }
    let ok = false;
    try {
      ok = shipVerified(git("log", "-1", "--format=%B", localSha), git("rev-parse", `${localSha}^{tree}`));
    } catch {
      ok = false;
    }
    if (ok) continue;
    console.error(
      [
        "ОСТАНОВЛЕНО: push в main мимо `npm run ship`.",
        "Сервер такую вершину не выкатит, а карта и проверки на main покраснеют у всех.",
        "Что делать: запушь свою ветку (git push -u origin <ветка>), открой черновик PR",
        "и запусти `npm run ship` из основной папки — он проверит и вольёт сам. Разбор — docs/ship.md.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("pre-push.mjs")) main();

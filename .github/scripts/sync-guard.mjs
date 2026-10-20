#!/usr/bin/env node
/**
 * СТОРОЖ ВЕТОК — чтобы работа двух человек сходилась сама, а не раз в неделю руками.
 *
 * ЗАЧЕМ. 10.09.2026 выяснилось, что коллега шесть дней писал логику продавца в ветке
 * `claude/github-getting-started-65jo72`: 139 файлов, 13 000 строк, 15 миграций. В `main`
 * не попало ничего, и НИ ОДИН инструмент этого не показывал. PR под эту ветку был —
 * #180, — но его закрыли 09.09 (первый коммит дублировал уже смерженное). Закрытый PR
 * обратно не открывается, а коммиты продолжили ложиться в ту же ветку. В итоге работа
 * одновременно отсутствовала в `main`, в списке открытых PR и в утренней очереди
 * автопроверки (`.claude/hooks/auto-health-prs.mjs` читает только PR). Видно её было
 * лишь тому, кто её писал, — и он считал, что всё сдал.
 *
 * За те же шесть дней `main` ушёл вперёд на 472 коммита (весь перенос темы 2026), и
 * сухое слияние стало давать 14 конфликтов. Это и есть цена молчания: чем дольше ветка
 * живёт незамеченной, тем дороже её внести.
 *
 * ЧТО ДЕЛАЕТ СТОРОЖ (раз в сутки и по кнопке):
 *   1. Берёт ВЕТКИ, а не список PR. Ветка — то, где лежит работа; PR — лишь заявка на
 *      неё. Пустой список заявок и отсутствие работы дают одинаковый вывод, и только
 *      второе безобидно, поэтому считаем всегда по веткам.
 *   2. Ветке с коммитами, у которой нет ОТКРЫТОГО PR, заводит черновой PR сам. С этой
 *      минуты работа видна в очереди, а CI прогоняет по ней сборку и тесты (ci.yml
 *      срабатывает на `pull_request`) — то есть проверяется тоже сама.
 *   3. Открытым PR пишет одно закреплённое сообщение: насколько ветка отстала, сколько
 *      дней молчит и КАКИЕ ФАЙЛЫ конфликтуют с `main` прямо сейчас. Не «когда-нибудь
 *      будет больно», а список путей, который можно посмотреть сегодня. Конфликт в
 *      СОБРАННЫХ файлах (карта, шрифт) считается отдельно и ветку разошедшейся не
 *      объявляет: он есть у всех живых веток после каждого вливания в `main` и
 *      пересобирается сам (02.10.2026, см. GENERATED_FILES ниже).
 *   4. Если на PR висит метка `авто-синхро`, сам вливает свежий `main` в ветку и пушит —
 *      но только когда слияние чистое. Конфликт разруливает человек, машина не гадает.
 *
 * ЧЕГО НЕ ДЕЛАЕТ: не мержит в `main`, не закрывает PR, не трогает ветку без метки.
 * Решение выкатывать — владельца, сторож только не даёт работе потеряться.
 *
 * ПОЧЕМУ REST, А НЕ `gh`. Прогон идёт на своём раннере (VPS, см. ci.yml): это не чистый
 * образ GitHub, и `gh` там может не стоять вовсе. Голый `fetch` с `GITHUB_TOKEN` не
 * требует на машине ничего, кроме Node.
 *
 * ОГРАНИЧИТЕЛИ (переменные окружения, значения по умолчанию — в sync-guard.yml):
 *   ACTIVE_DAYS   ветку старше стольких дней не трогаем: это архив, а не работа.
 *   MAX_NEW_PRS   больше стольких PR за прогон не создаём. Первый запуск иначе открыл бы
 *                 сразу девять и заказал девять прогонов CI на боевом VPS (2 ядра).
 *   STALE_BEHIND  отставание в коммитах, после которого сторож начинает писать в PR.
 *   DRY_RUN=1     всё посчитать и показать, но ничего не создавать и не писать.
 *
 * Железное правило общее с хуками репозитория: НЕ МЕШАТЬ. Любая осечка по одной ветке —
 * строка в отчёте и переход к следующей, а не падение всего прогона.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const REPO = process.env.GITHUB_REPOSITORY ?? "DalerJaborov/royal-home-crm-public";
const [OWNER] = REPO.split("/");
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const BASE = process.env.BASE_BRANCH ?? "main";
const ACTIVE_DAYS = Number(process.env.ACTIVE_DAYS ?? 7);
const MAX_NEW_PRS = Number(process.env.MAX_NEW_PRS ?? 3);
const STALE_BEHIND = Number(process.env.STALE_BEHIND ?? 40);
const DRY_RUN = process.env.DRY_RUN === "1";
const SYNC_LABEL = process.env.SYNC_LABEL ?? "авто-синхро";

/** Ветки, которые ведёт не человек и не мы: у них свой хозяин и свои правила. */
const IGNORED_PREFIXES = ["dependabot/", "revert-", "gh-readonly-queue/"];

/** Метка закреплённого сообщения: по ней сторож находит и правит своё, а не плодит новые. */
const MARKER = "<!-- sync-guard -->";

const tmp = mkdtempSync(join(tmpdir(), "sync-guard-"));

async function git(args, opts = {}) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout.trim();
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "royal-home-sync-guard",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function daysSince(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Ветки удалённого репозитория с датой, автором и темой последнего коммита.
 * Читаем из локальных `refs/remotes/origin` — после `fetch --prune` это точный слепок.
 */
async function listBranches() {
  const raw = await git([
    "for-each-ref",
    "--format=%(refname:short)\t%(committerdate:iso-strict)\t%(authorname)\t%(subject)",
    "refs/remotes/origin",
  ]);
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, date, author, ...rest] = line.split("\t");
    const name = ref.replace(/^origin\//, "");
    if (name === BASE || name === "HEAD" || name === "") continue;
    if (IGNORED_PREFIXES.some((p) => name.startsWith(p))) continue;
    out.push({ name, ref, date, author, subject: rest.join("\t") });
  }
  return out;
}

/**
 * Конфликты ветки с `main` НА СЕГОДНЯ — сухое слияние без рабочего дерева.
 *
 * `merge-tree --write-tree` появился в git 2.38. На раннере может стоять старее, и это
 * не повод ронять прогон: возвращаем null, отчёт напишет «посчитать не удалось». Молча
 * подставлять ноль конфликтов нельзя — это ровно та ложная зелень, из-за которой ветка
 * и протухает незамеченной.
 */
async function conflictsWith(branchRef) {
  try {
    await git(["merge-tree", "--write-tree", "--name-only", `origin/${BASE}`, branchRef]);
    return []; // нулевой код возврата = слияние чистое
  } catch (err) {
    const out = `${err.stdout ?? ""}`;
    if (!out.includes("CONFLICT")) return null; // не конфликт, а неподдерживаемая команда
    const files = new Set();
    for (const line of out.split("\n")) {
      const del = line.match(/^CONFLICT \([^)]*\): (.+?) deleted in /);
      if (del) { files.add(del[1].trim()); continue; }
      const m = line.match(/^CONFLICT \([^)]*\): (?:Merge conflict in |.*? in )(.+)$/);
      if (m) files.add(m[1].trim());
    }
    return [...files];
  }
}

/** Все PR по этой ветке — включая закрытые: именно закрытый PR и прячет работу. */
async function prsFor(branch) {
  try {
    const list = await api(
      "GET",
      `/repos/${REPO}/pulls?head=${encodeURIComponent(`${OWNER}:${branch}`)}&state=all&per_page=20`
    );
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * СГЕНЕРИРОВАННЫЕ отслеживаемые файлы — те, что собираются из кода скриптами
 * (`npm run map`, `npm run gen:typeset`) и лежат в git готовыми. Конфликт в них —
 * НЕ расхождение работы: он возникает у ВСЕХ живых веток после каждого вливания в
 * `main`, потому что обе стороны пересобрали один и тот же файл из разного кода.
 * Разбирать его руками не надо и нельзя — `npm run sync:main` берёт версию `main` и
 * пересобирает карту заново, а `map:check`/`audit:typeset` в `precheck` и в CI не
 * дадут уехать с несобранной.
 *
 * ПОЧЕМУ СПИСОК, А НЕ МАСКА `docs/product-*`. Под маску попали бы
 * `docs/product-map-labels.json` и `docs/product-map-words.json` — два словаря
 * подписей, которые правятся РУКАМИ (CLAUDE.md: это единственное в карте, что можно
 * править человеку), и `docs/product-map-gaps-20-09.md` с `docs/product-map-razbor-19-09.md`
 * — написанные разборы. Конфликт в любом из них настоящий, и спрятать его под
 * «это сгенерированное» значило бы завести ровно ту слепоту, против которой весь
 * сторож и написан. Поэтому перечисление, и новый генератор дописывается сюда руками.
 */
const GENERATED_FILES = new Set([
  "docs/product-flows.json",
  "docs/product-flows.md",
  "docs/product-map.json",
  "docs/product-map.md",
  "docs/product-map-simple.json",
  "apps/web/src/theme-2026-typeset.css",
]);

/** Разложить конфликты на содержательные и те, что пересоберутся сами. */
function splitConflicts(conflicts) {
  if (conflicts === null) return null;
  return {
    real: conflicts.filter((f) => !GENERATED_FILES.has(f)),
    generated: conflicts.filter((f) => GENERATED_FILES.has(f)),
  };
}

function describeConflicts(conflicts) {
  if (conflicts === null) return "посчитать не удалось (старый git на раннере)";
  if (conflicts.length === 0) return "нет, сливается чисто";
  const { real, generated } = splitConflicts(conflicts);
  const list = (files) => {
    const head = files.slice(0, 12).map((f) => `\`${f}\``).join(", ");
    return head + (files.length > 12 ? ` и ещё ${files.length - 12}` : "");
  };
  const parts = [];
  if (real.length > 0) parts.push(`**${real.length}** по существу — ${list(real)}`);
  if (generated.length > 0) {
    parts.push(
      `${generated.length} в собранных файлах (${list(generated)}) — ` +
        "разбирать не надо, `npm run sync:main` пересоберёт"
    );
  }
  return parts.join("; ");
}

async function createDraftPr(b, closedPr) {
  const reason = closedPr
    ? `PR #${closedPr.number} по этой ветке закрыт ${String(closedPr.closed_at ?? "").slice(0, 10) || "ранее"}, ` +
      `а коммиты продолжили в неё ложиться. Закрытый PR обратно не открывается, поэтому работа ` +
      `не показывалась нигде — ни в \`${BASE}\`, ни в очереди PR.`
    : `У ветки есть коммиты, но не было ни одного PR — работа не показывалась ни в \`${BASE}\`, ни в очереди.`;

  const body =
    `${MARKER}\n` +
    `**Черновик заведён сторожем веток автоматически.** Это не заявка на слияние: черновик ` +
    `нужен, чтобы работу стало видно и чтобы CI прогнал по ней сборку и тесты.\n\n` +
    `${reason}\n\n` +
    `- Ветка: \`${b.name}\`, автор последнего коммита: ${b.author}\n` +
    `- Своих коммитов: **${b.ahead}**, отставание от \`${BASE}\`: **${b.behind}**\n` +
    `- Последний коммит: ${b.date.slice(0, 10)} (${b.ageDays} дн. назад) — ${b.subject}\n` +
    `- Конфликты с \`${BASE}\` сейчас: ${describeConflicts(b.conflicts)}\n\n` +
    `Что с этим делать: либо довести до слияния (сначала влить \`${BASE}\` в ветку — ` +
    `\`git fetch origin && git merge origin/${BASE}\`), либо закрыть PR **и удалить ветку**. ` +
    `Закрыть PR, оставив ветку, — это и есть та ловушка, из-за которой сторож написан.\n`;

  const pr = await api("POST", `/repos/${REPO}/pulls`, {
    title: `[черновик] ${b.subject}`.slice(0, 250),
    head: b.name,
    base: BASE,
    body,
    draft: true,
  });
  return pr.html_url;
}

function stickyBody(b) {
  const lines = [
    MARKER,
    `### Состояние ветки \`${b.name}\` относительно \`${BASE}\``,
    "",
    `- Своих коммитов: **${b.ahead}** · отставание: **${b.behind}** коммитов`,
    `- Последний коммит: ${b.date.slice(0, 10)} (${b.ageDays} дн. назад)`,
    `- Конфликты при слиянии сейчас: ${describeConflicts(b.conflicts)}`,
    "",
  ];
  // «Разошлась» — про отставание и про конфликты ПО СУЩЕСТВУ. Конфликт в собранных
  // файлах сюда не входит: он появляется у всех живых веток после каждого вливания в
  // `main` и ничего про расхождение работы не говорит. Пока он тоже поднимал это
  // предупреждение, оно горело почти на каждом PR почти всегда — а предупреждение,
  // которое горит всегда, читать перестают ровно к тому дню, когда конфликт настоящий.
  const split = splitConflicts(b.conflicts);
  const realConflicts = split ? split.real.length : 0;
  const generatedOnly = split && split.real.length === 0 && split.generated.length > 0;

  if (b.behind >= STALE_BEHIND || realConflicts > 0) {
    // Свод нужен и когда в придачу конфликтуют собранные файлы: голый `git merge`
    // оставит в них маркеры конфликта, а `npm run sync:main` возьмёт версию `main` и
    // пересоберёт карту сам — это и есть написанный для этого случая порядок.
    const cmd =
      split && split.generated.length > 0
        ? "npm run sync:main"
        : `git fetch origin && git merge origin/${BASE}`;
    lines.push(
      `Ветка разошлась с \`${BASE}\`. Чем дольше это тянуть, тем дороже перенос — ` +
        `слить свежий \`${BASE}\` в ветку стоит сегодня:`,
      "",
      "```bash",
      cmd,
      "```",
      "",
      `Либо повесить на этот PR метку \`${SYNC_LABEL}\` — тогда сторож будет вливать ` +
        `\`${BASE}\` сам, пока слияние остаётся чистым.`
    );
  } else if (generatedOnly) {
    lines.push(
      `Работа идёт вровень с \`${BASE}\`: конфликтуют только собранные файлы, и это ` +
        `обычное состояние после вливания в \`${BASE}\`. Отдельно ничего делать не надо — ` +
        "`npm run sync:main` (а он же внутри `npm run ship`) пересоберёт их сам."
    );
  } else {
    lines.push(`Ветка идёт вровень с \`${BASE}\`, переносить нечего.`);
  }
  return lines.join("\n");
}

/**
 * Одно закреплённое сообщение на PR: находим своё по метке и правим, а не добавляем ещё
 * одно. Ежедневный сторож, пишущий новый комментарий каждые сутки, читать перестают за
 * неделю — и он становится ровно таким же молчанием, от которого заведён.
 */
async function upsertComment(prNumber, body) {
  let existing = null;
  try {
    const comments = await api("GET", `/repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
    existing = comments.find((c) => (c.body ?? "").includes(MARKER)) ?? null;
    if (existing && (existing.body ?? "").trim() === body.trim()) return "без изменений";
  } catch {
    /* не прочитали — просто напишем новое */
  }
  if (DRY_RUN) return existing ? "правка (сухой прогон)" : "новое (сухой прогон)";
  if (existing) {
    await api("PATCH", `/repos/${REPO}/issues/comments/${existing.id}`, { body });
    return "поправлено";
  }
  await api("POST", `/repos/${REPO}/issues/${prNumber}/comments`, { body });
  return "написано";
}

/**
 * Авто-синхронизация по метке: вливаем `main` в ветку и пушим.
 * Только чистое слияние — при конфликте откатываемся и оставляем всё человеку.
 */
async function autoSync(b) {
  const wt = join(tmp, `wt-${b.name.replace(/[^\w.-]/g, "_")}`);
  try {
    await git(["worktree", "add", "--detach", wt, b.ref]);
    await git(
      ["merge", "--no-edit", "-m", `Merge origin/${BASE} в ${b.name} (авто-синхронизация)`, `origin/${BASE}`],
      { cwd: wt }
    );
    if (DRY_RUN) return "слилось чисто (сухой прогон, не запушено)";
    await git(["push", "origin", `HEAD:refs/heads/${b.name}`], { cwd: wt });
    return `влит \`${BASE}\` (+${b.behind} коммитов)`;
  } catch (err) {
    try { await git(["merge", "--abort"], { cwd: wt }); } catch { /* нечего откатывать */ }
    return `не вышло: ${String(err.stderr ?? err.message).split("\n")[0]}`;
  } finally {
    try { await git(["worktree", "remove", "--force", wt]); } catch { /* уже нет */ }
  }
}

async function main() {
  if (!TOKEN) throw new Error("Нет GITHUB_TOKEN — сторожу нечем читать и заводить PR");
  await git(["fetch", "--prune", "origin"]);

  const branches = await listBranches();
  const report = [];
  let created = 0;

  // ПЕРВЫМ ПРОХОДОМ — только замеры, без единого действия.
  //
  // Иначе очередь на создание PR разбирается в алфавитном порядке имён веток, а предел
  // MAX_NEW_PRS делает этот порядок значимым: ветка коллеги с одиннадцатью коммитами
  // ждала бы своей ночи за `chore/`-мелочью в один коммит. Сортируем по объёму скрытой
  // работы — сначала то, потеря чего дороже.
  const live = [];
  for (const b of branches) {
    try {
      b.ahead = Number(await git(["rev-list", "--count", `origin/${BASE}..${b.ref}`]));
      if (b.ahead === 0) continue; // всё уже в main — ветка просто не удалена
      b.behind = Number(await git(["rev-list", "--count", `${b.ref}..origin/${BASE}`]));
      b.ageDays = daysSince(b.date) ?? 999;
      b.conflicts = await conflictsWith(b.ref);
      b.prs = await prsFor(b.name);
      live.push(b);
    } catch (err) {
      report.push(`| \`${b.name}\` | — | ? | ? | ? | осечка замера: ${String(err.message).split("\n")[0]} |`);
    }
  }

  const withOpenPr = live.filter((b) => b.prs.some((p) => p.state === "open"));
  const needPr = live
    .filter((b) => !b.prs.some((p) => p.state === "open"))
    .sort((x, y) => y.ahead - x.ahead || String(y.date).localeCompare(String(x.date)));

  for (const b of [...withOpenPr, ...needPr]) {
    try {
      const prs = b.prs;
      const open = prs.find((p) => p.state === "open");

      if (open) {
        const labels = (open.labels ?? []).map((l) => l.name);
        let synced = null;
        if (labels.includes(SYNC_LABEL) && b.behind > 0) {
          synced = await autoSync(b);
          if (!synced.startsWith("не вышло")) {
            // после слияния прежние цифры устарели — пересчитываем, чтобы в PR не ушла ложь
            await git(["fetch", "--prune", "origin"]);
            b.behind = Number(await git(["rev-list", "--count", `${b.ref}..origin/${BASE}`]));
            b.conflicts = await conflictsWith(b.ref);
          }
        }
        const what = await upsertComment(open.number, stickyBody(b));
        report.push(
          `| \`${b.name}\` | #${open.number}${open.draft ? " (черновик)" : ""} | ${b.ahead} | ${b.behind} | ` +
            `${b.conflicts === null ? "?" : b.conflicts.length} | ${synced ? `синхро: ${synced}; ` : ""}${what} |`
        );
        continue;
      }

      if (b.ageDays > ACTIVE_DAYS) {
        report.push(
          `| \`${b.name}\` | — | ${b.ahead} | ${b.behind} | ${b.conflicts?.length ?? "?"} | молчит ${b.ageDays} дн., не трогаем |`
        );
        continue;
      }

      const closed = prs
        .filter((p) => p.state !== "open")
        .sort((x, y) => String(y.closed_at).localeCompare(String(x.closed_at)))[0] ?? null;

      if (created >= MAX_NEW_PRS) {
        report.push(
          `| \`${b.name}\` | нет PR | ${b.ahead} | ${b.behind} | ${b.conflicts?.length ?? "?"} | **очередь: предел ${MAX_NEW_PRS} PR за прогон** |`
        );
        continue;
      }

      if (DRY_RUN) {
        created += 1;
        report.push(
          `| \`${b.name}\` | нет PR | ${b.ahead} | ${b.behind} | ${b.conflicts?.length ?? "?"} | завёл бы черновик (сухой прогон) |`
        );
        continue;
      }

      const url = await createDraftPr(b, closed);
      created += 1;
      report.push(
        `| \`${b.name}\` | ${url} | ${b.ahead} | ${b.behind} | ${b.conflicts?.length ?? "?"} | **черновик заведён** |`
      );
    } catch (err) {
      report.push(`| \`${b.name}\` | — | ${b.ahead} | ${b.behind} | ? | осечка: ${String(err.message).split("\n")[0]} |`);
    }
  }

  const summary =
    `## Сторож веток — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n\n` +
    (DRY_RUN ? "_Сухой прогон: ничего не создано и не написано._\n\n" : "") +
    `Ветка \`${BASE}\`, порог активности ${ACTIVE_DAYS} дн., предел новых PR за прогон ${MAX_NEW_PRS}.\n\n` +
    (report.length === 0
      ? "Несведённых веток нет — вся работа либо в `main`, либо в открытых PR.\n"
      : `| ветка | PR | своих | отстаёт | конфликтов | что сделано |\n|---|---|---|---|---|---|\n${report.join("\n")}\n`);

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
}

// Запускаемся ТОЛЬКО когда файл вызвали напрямую (`node .github/scripts/sync-guard.mjs`).
// При импорте из теста обход веток не нужен и невозможен: он ходит в GitHub по токену.
// Без этой проверки `import` поднял бы весь прогон, поэтому чистые функции выше и
// оставались непроверенными.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("Сторож веток упал:", err);
    process.exit(1);
  });
}

export { GENERATED_FILES, splitConflicts, describeConflicts, stickyBody };

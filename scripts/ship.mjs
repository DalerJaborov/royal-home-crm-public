#!/usr/bin/env node
/**
 * ВЫКАТ ПРАВКИ НА САЙТ — ОДНОЙ КОМАНДОЙ. ДРУГОГО ПУТИ НА САЙТ НЕТ.
 *
 *   npm run ship                     # свести, проверить, отметить, влить
 *   npm run ship -- --no-merge       # всё то же, но остановиться перед вливанием
 *   npm run ship -- --dry-run        # только показать план и что мешает; ничего не менять
 *   npm run ship -- --full           # полный прогон тестов сервера даже там, где правило его отпускает
 *   npm run ship -- --clean-db       # полный прогон на новой пустой базе rh_clean_<время>
 *   npm run ship -- --pr=123         # номер правки явно (иначе ищется по ветке)
 *   npm run ship -- --local-tests    # полный прогон здесь, а не в облаке GitHub (GitHub недоступен)
 *
 * ПРОВЕРКИ — В ОБЛАКЕ (21.10.2026). Полный прогон API идёт на 20 машинах GitHub
 * (.github/workflows/ship-tests.yml), source-only — в ci.yml. Ship отправляет
 * проверяемый коммит после сведения, ждёт сборку, precheck и нужные тесты на
 * GitHub. Для полного API прогона ship скачивает итоговый
 * отчёт и проверяет его сам — тем же requireFullApiRunPassed, что и локальный, —
 * и что отчёт именно про этот sha. Ветка удаляется в любом исходе.
 *
 * ЗАЧЕМ. Влитое в `main` уезжает на сайт таймером на сервере в течение минуты
 * (CLAUDE.md, «Как код попадает на прод»), а проверки GitHub с 22.09.2026 не
 * запускаются вовсе. Значит, проверка перед вливанием — единственная дверь, и до
 * этого скрипта её держала память каждой сессии: «свести с main по sha, precheck,
 * полный test:api, 120000, журнал, влить squash, после — сборка на main». 24.09 в
 * `main` мимо этого списка прошли две правки, одна сломала `map:check` у всех.
 *
 * Скрипт делает ровно этот список, по порядку, и на первом красном шаге
 * ОСТАНАВЛИВАЕТСЯ, называя, что красное. В конце зелёного пути он вливает squash
 * со строкой-отметкой `Ship-Verified: tree=<дерево>` в сообщении коммита, и
 * сервер выката (ops/auto-deploy.sh) берёт на сайт только такую вершину main —
 * кто бы ни нажимал кнопку: этот чат, Claude Code на ноутбуке, другая учётка.
 * Влитое мимо команды остаётся в GitHub, но на сайт не едет (выбор Dan 24.09).
 *
 * ЭТАПЫ (номера — те же, что в выводе):
 *   1. подготовка   ветка не main, дерево чистое, есть доступ к GitHub, правка открыта
 *   2. свести       с main по ЯВНОМУ sha (scripts/sync-main.mjs --onto=<sha>);
 *                   конфликт в docs/product-* — версия main + `npm run map`
 *   3. режимы       в правке нет ссылок (120000) и вложенных репозиториев (160000)
 *   4. миграции     все недостающие (свои и пришедшие из main) — на тестовую базу
 *   5. precheck     сборки, аудиты, карта, сторож карты, журнал, тесты фронта
 *   6. тесты API    полный прогон, 0 падений (правило «пачки» — ниже)
 *   7. отправить    ветку в GitHub (без силы: чужие коммиты не затираются)
 *   8. отметка      строка Ship-Verified для коммита; статус GitHub — где дают
 *   9. влить        squash со строкой, только если main всё ещё тот самый sha
 *  10. после        дерево main совпадает с проверенным побайтно — иначе сборки на main
 *
 * ПРАВИЛО «ПАЧКИ» (когда полный прогон тестов сервера не нужен). Решение Dan
 * 24.09: «правка только теста или только сайта (api не тронут) — без полного
 * прогона api». Скрипт решает это сам по списку файлов правки (`needsFullApiRun`):
 * полный прогон нужен, если тронуто хоть что-то, что исполняется сервером или
 * тестовой обвязкой — `apps/api/*` кроме файлов `*.test.ts`, `packages/*`,
 * корневые `package.json`/`package-lock.json`. Иначе precheck гоняет тесты,
 * задетые правкой по импортам (там же и сами изменённые `*.test.ts`), а полный
 * прогон пропускается с объяснением в выводе. `--full` включает его всегда.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STATUS_CONTEXT = "проверено";

// ── Чистые функции (их проверяет scripts/ship.test.mjs) ──────────────────────

/** Node 24.16 includes nodejs/node#62561: random Windows TCP stack-cookie crashes. */
export function shipRuntimeProblem(platform, version) {
  const parts = /^v?(\d+)\.(\d+)\./.exec(version);
  return platform === "win32" && parts && Number(parts[1]) === 24 && Number(parts[2]) < 16
    ? `Node ${version} на Windows содержит известный дефект TCP с авариями worker (0xC0000409); запусти ship на Node 24.16+ (docs/ship.md)`
    : null;
}

export function parseArgs(argv) {
  const opts = { dryRun: false, noMerge: false, full: false, cleanDb: false, localTests: false, pr: null, help: false };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--local-tests") opts.localTests = true;
    else if (a === "--no-merge") opts.noMerge = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--clean-db") opts.cleanDb = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--pr=")) {
      const n = Number(a.slice("--pr=".length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--pr ждёт номер правки, а пришло «${a}»`);
      opts.pr = n;
    } else throw new Error(`незнакомый ключ «${a}» (см. npm run ship -- --help)`);
  }
  return opts;
}

/** Нужен ли полный прогон тестов сервера. Возвращает {full, why}. */
export function needsFullApiRun(files) {
  const hit = files.find(
    (f) =>
      f.startsWith("apps/api/") ||
      f.startsWith("packages/") ||
      f === "package.json" ||
      f === "package-lock.json",
  );
  if (hit) return { full: true, why: `правка задевает сервер или общую часть (${hit})` };
  return {
    full: false,
    why: "сервер и общая часть не тронуты (только сайт, тесты, документы, скрипты) — хватает тестов, задетых правкой",
  };
}

/**
 * Строки `git diff --raw`, где файл СТАНОВИТСЯ ссылкой (120000) или вложенным
 * репозиторием (160000). Формат: `:old new oldsha newsha status\tpath`.
 * Так правкой #850 в main чуть не уехали ссылки вместо файлов; gitlink — след
 * `git add -A` по `.claude/worktrees/*`.
 */
export function badModes(rawDiff) {
  const out = [];
  for (const line of rawDiff.split("\n")) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ (\S+)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, , newMode, , path] = m;
    if (newMode === "120000") out.push({ path, kind: "ссылка (120000)" });
    if (newMode === "160000") out.push({ path, kind: "вложенный репозиторий (160000)" });
  }
  return out;
}

export function newMigrations(files) {
  return files.filter((f) => /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f));
}

/** owner/repo из адреса origin (https, ssh, локальный прокси с /git/owner/repo).
 *  Разделитель и `\` тоже: на Windows локальный origin — путь вида
 *  C:\…\origin.git, и тест команды выката на нём падал (25.09.2026). */
export function parseRepo(remoteUrl) {
  const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim().replace(/\\/g, "/"));
  if (!m) throw new Error(`не разобрать адрес origin: ${remoteUrl}`);
  return { owner: m[1], repo: m[2] };
}

/** Описание отметки: GitHub режет его на 140 символах. */
export function statusDescription({ mainSha, apiTests, full }) {
  const tests = full ? `полный test:api ${apiTests} тестов, 0 падений` : "тесты по правилу пачки";
  return `npm run ship: precheck, ${tests}, main ${mainSha.slice(0, 9)}`.slice(0, 140);
}

/**
 * Строка-отметка в сообщении squash-коммита. `tree=` — дерево проверенного
 * коммита: у squash-вливания свежей ветки дерево то же самое, так что сервер
 * выката проверяет её одной командой `git rev-parse <sha>^{tree}`.
 */
export function shipTrailer({ tree, mainSha, apiTests, full }) {
  return `Ship-Verified: tree=${tree} main=${mainSha} api-tests=${full ? apiTests : "batch"} failed=0`;
}

/**
 * Итог runParallel обязателен целиком: его success учитывает аварии workers и
 * незавершённые assertions. Зелёный повтор отдельных файлов не заменяет этот
 * итог: рядом с обычным падением мог остаться незавершённый другой файл.
 */
export function requireFullApiRunPassed(code, rep) {
  const validReport = rep !== null && typeof rep === "object" && !Array.isArray(rep) &&
    Number.isSafeInteger(rep.numTotalTests) && rep.numTotalTests > 0 &&
    rep.numFailedTests === 0 && rep.numFailedTestSuites === 0;
  if (code !== 0 || !validReport || rep.success !== true) {
    throw new Stop("полный прогон тестов сервера красный или отчёт некорректен — исправь причину и запусти полный ship заново; повторы отдельных файлов служат только диагностикой");
  }
  return rep.numTotalTests;
}

// ── Облачный прогон (.github/workflows/ship-tests.yml) ──────────────────────

export const CLOUD_WORKFLOW = "ship-tests.yml";
export const CLOUD_ARTIFACT = "api-tests-total";
/** Ветка, пуш в которую запускает облачный прогон ровно этого коммита. */
export const cloudBranch = (sha) => `ship-tests/${sha}`;
export const SOURCE_WORKFLOW = "ci.yml";
export const sourceBranch = (sha) => `source-checks/${sha}`;

/** Repository-wide run discovery also works before a new workflow reaches main. */
export function findCloudRun(runs, {sha, branch, startedAt, workflow = CLOUD_WORKFLOW}) {
  return (Array.isArray(runs) ? runs : [])
    .filter(x => x.path === `.github/workflows/${workflow}` && x.head_sha === sha &&
      x.event === "push" && x.head_branch === branch && Date.parse(x.created_at) >= startedAt - 60_000)
    .sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

export function requireSourceRunPassed({run, jobs, sha}) {
  if (!run || run.status !== "completed" || run.conclusion !== "success" ||
      run.head_sha !== sha || run.path !== `.github/workflows/${SOURCE_WORKFLOW}`) {
    throw new Stop(`проверка исходников для этого sha не пройдена: ${run?.html_url ?? "нет прогона"}`);
  }
  const checked = (Array.isArray(jobs) ? jobs : []).filter(job => job.name === "precheck");
  if (checked.length !== 1 || checked[0].status !== "completed" || checked[0].conclusion !== "success") {
    throw new Stop("нет успешного задания precheck — выпуск запрещён");
  }
  return 0;
}

/**
 * Вердикт облачного прогона. Верим не слову «success» у GitHub, а отчёту:
 * прогон завершён и успешен, он про НАШ sha (и по GitHub, и по файлу внутри
 * артефакта), а отчёт проходит ту же проверку, что и локальный.
 */
export function requireCloudRunPassed({ run, reportSha, report, sha }) {
  if (!run || run.status !== "completed") throw new Stop("облачный прогон не завершён — считать его пройденным нельзя");
  if (run.head_sha !== sha) {
    throw new Stop(`облачный прогон проверял ${String(run.head_sha).slice(0, 9)}, а уезжает ${sha.slice(0, 9)}`);
  }
  if (String(reportSha ?? "").trim() !== sha) {
    throw new Stop(`отчёт облачного прогона про ${String(reportSha ?? "?").trim().slice(0, 9)}, а не про ${sha.slice(0, 9)}`);
  }
  if (run.conclusion !== "success") {
    throw new Stop(
      run.conclusion === "startup_failure"
        ? "GitHub не запустил облачный прогон (startup_failure — обычно биллинг учётки). Выкат без облака: npm run ship -- --local-tests"
        : `облачный прогон тестов сервера: ${run.conclusion} — ${run.html_url}`,
    );
  }
  const count = requireFullApiRunPassed(0, report);
  if (report.sourceChecks?.sha !== sha || report.sourceChecks?.result !== "success") {
    throw new Stop("нет успешной проверки исходников для этого sha — сборку и precheck пропускать нельзя");
  }
  return count;
}

/**
 * Снимок проверяемого состояния: вершина, дерево и «грязь» отслеживаемых файлов.
 * `git` — функция вида (...args) => stdout (из makeRunner).
 */
export function snapshotState(git) {
  return {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    // Только отслеживаемые файлы: сборки и тесты оставляют неотслеживаемые артефакты,
    // а вот правка отслеживаемого файла посреди прогона значит, что проверялось не то, что уедет.
    dirty: git("status", "--porcelain", "--untracked-files=no"),
  };
}

/**
 * Что изменилось в общем рабочем дереве между началом проверок и отправкой. Пустой
 * список — проверенное и отправляемое совпадают. Аудит Codex 04.10, OPS10: в общем
 * checkout пока шли минуты тестов, кто-то мог закоммитить B поверх проверяемого A, и
 * ship читал HEAD только ПОСЛЕ тестов, пушил B и выдавал ему Ship-Verified с деревом B
 * и результатами A — строгий сторож сервера такую отметку принимал.
 */
export function stateDrift(verified, now) {
  const problems = [];
  if (now.head !== verified.head) {
    problems.push(`HEAD сдвинулся ${verified.head.slice(0, 9)} → ${now.head.slice(0, 9)} (кто-то коммитил в это дерево)`);
  }
  if (now.tree !== verified.tree) {
    problems.push(`дерево изменилось ${verified.tree.slice(0, 9)} → ${now.tree.slice(0, 9)}`);
  }
  if (now.dirty) problems.push(`отслеживаемые файлы правили во время проверки:\n    ${now.dirty.split("\n").join("\n    ")}`);
  return problems;
}

// ── Облачный прогон: запуск и ожидание ───────────────────────────────────────

const sleepMs = (ms) => new Promise((res) => setTimeout(res, ms));
/** Сколько ждать, пока GitHub заведёт прогон после пуша, и весь прогон целиком. */
const CLOUD_APPEAR_MS = 5 * 60_000;
const CLOUD_TOTAL_MS = 90 * 60_000;

/**
 * Пуш проверяемого коммита в `ship-tests/<sha>` — это и есть запуск
 * (`on: push` в ship-tests.yml). Старую ветку с тем же именем сначала
 * удаляем: пуш того же sha в существующую ветку прогона не заводит.
 */
function startCloudTests({ gh, run, repo, sha, branch = cloudBranch(sha) }) {
  const startedAt = Date.now();
  // Удаление старой ветки — молча: её почти всегда нет.
  spawnSync("git", ["push", "origin", "--delete", branch], { stdio: "ignore" });
  const r = run("git", ["push", "origin", `${sha}:refs/heads/${branch}`]);
  if (r.code !== 0) throw new Stop(`не удалось отправить ${sha.slice(0, 9)} в ${branch} для облачного прогона`);
  const cloudRun = { branch, sha, startedAt, id: null };
  state.cleanup = async () => {
    state.cleanup = null;
    if (cloudRun.id) {
      try {
        const now = await gh.call("GET", `/{repo}/actions/runs/${cloudRun.id}`);
        if (now?.status !== "completed") await gh.call("POST", `/{repo}/actions/runs/${cloudRun.id}/cancel`, {});
      } catch {
        /* прогон уже кончился или GitHub недоступен — ветку всё равно убираем */
      }
    }
    try {
      await gh.call("DELETE", `/{repo}/git/refs/heads/${branch}`);
    } catch (err) {
      console.log(`  ветку ${branch} убрать не удалось (${err.message}) — убери руками: git push origin --delete ${branch}`);
    }
  };
  console.log(`  облачный прогон запущен: ${repo.owner}/${repo.repo}, ветка ${branch}`);
  return cloudRun;
}

/** Дождаться облачного прогона, скачать итоговый отчёт и проверить его здесь. */
async function waitCloudWorkflow({ gh, sha, cloudRun, workflow = CLOUD_WORKFLOW }) {
  const deadline = cloudRun.startedAt + CLOUD_TOTAL_MS;
  let runInfo = null;
  let lastNote = 0;
  for (;;) {
    if (!cloudRun.id) {
      const list = await gh.call(
        "GET",
        `/{repo}/actions/runs?head_sha=${sha}&event=push&per_page=50`,
      );
      // Только прогон, заведённый ЭТИМ пушем: старые прогоны того же sha не в счёт.
      const mine = findCloudRun(list?.workflow_runs, {sha, branch:cloudRun.branch, startedAt:cloudRun.startedAt, workflow});
      if (mine) {
        cloudRun.id = mine.id;
        console.log(`  прогон ${mine.html_url}`);
      } else if (Date.now() - cloudRun.startedAt > CLOUD_APPEAR_MS) {
        throw new Stop(
          "GitHub за 5 минут не завёл облачный прогон (Actions выключены или биллинг учётки). Выкат без облака: npm run ship -- --local-tests",
        );
      }
    }
    if (cloudRun.id) {
      runInfo = await gh.call("GET", `/{repo}/actions/runs/${cloudRun.id}`);
      if (runInfo.status === "completed") break;
      if (Date.now() - lastNote > 60_000) {
        lastNote = Date.now();
        const jobs = await gh.call("GET", `/{repo}/actions/runs/${cloudRun.id}/jobs?per_page=100`);
        const all = jobs?.jobs ?? [];
        const doneJobs = all.filter((j) => j.status === "completed").length;
        const red = all.filter((j) => j.status === "completed" && j.conclusion !== "success" && j.conclusion !== "skipped");
        const mins = Math.round((Date.now() - cloudRun.startedAt) / 60_000);
        console.log(`  ${mins} мин: заданий готово ${doneJobs} из ${all.length}${red.length ? `, красных ${red.length} (${red.map((j) => j.name).join(", ")})` : ""}`);
      }
    }
    if (Date.now() > deadline) throw new Stop(`облачный прогон не кончился за ${CLOUD_TOTAL_MS / 60_000} минут — остановлен`);
    await sleepMs(15_000);
  }
  return runInfo;
}

async function waitSourceChecks({gh, sha, cloudRun}) {
  const run = await waitCloudWorkflow({gh,sha,cloudRun,workflow:SOURCE_WORKFLOW});
  const result = await gh.call("GET", `/{repo}/actions/runs/${cloudRun.id}/jobs?per_page=100`);
  return requireSourceRunPassed({run,jobs:result?.jobs,sha});
}

async function waitCloudTests({ gh, repo, token, sha, cloudRun }) {
  const runInfo = await waitCloudWorkflow({gh,sha,cloudRun});

  // Отчёт скачиваем и при красном итоге: имена упавших тестов — первое, что нужно.
  const dir = mkdtempSync(join(tmpdir(), "rh-ship-cloud-"));
  const dl = spawnSync("gh", ["run", "download", String(cloudRun.id), "-R", `${repo.owner}/${repo.repo}`, "-n", CLOUD_ARTIFACT, "-D", dir], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
  });
  let report = null;
  let reportSha = null;
  if (dl.status === 0 && existsSync(join(dir, "api-tests.json"))) {
    try {
      report = JSON.parse(readFileSync(join(dir, "api-tests.json"), "utf8"));
    } catch {
      report = null;
    }
    reportSha = existsSync(join(dir, "sha")) ? readFileSync(join(dir, "sha"), "utf8") : null;
  } else {
    console.log(`  итоговый отчёт не скачан: ${(dl.stderr || dl.error?.message || "").trim()}`);
  }
  if (report && runInfo.conclusion !== "success") {
    const { failureLines } = await import("./cloud-test-report.mjs");
    const lines = failureLines(report, 40);
    if (lines.length) console.log(lines.map((l) => `  ${l}`).join("\n"));
  }
  return requireCloudRunPassed({ run: runInfo, reportSha, report, sha });
}

// ── Исполнение ───────────────────────────────────────────────────────────────

const IS_WIN = process.platform === "win32";
/** shell — только для npm/npx на Windows (`.cmd`); для git вреден (cmd ест `^`). */
const needsShell = (cmd) => IS_WIN && (cmd === "npm" || cmd === "npx");

class Stop extends Error {}
/** Влито ли уже: после вливания «на сайт ничего не ушло» было бы неправдой. */
const state = { mergedSha: null, cleanup: null };

function makeRunner(root) {
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Stop(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
    return (r.stdout || "").trim();
  };
  const run = (cmd, args, opts = {}) => {
    const started = Date.now();
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd || root,
      stdio: "inherit",
      shell: needsShell(cmd),
      env: { ...process.env, ...(opts.env || {}) },
    });
    return { code: r.status === null ? 1 : r.status, ms: Date.now() - started };
  };
  return { git, run };
}

function fmt(ms) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} с` : `${Math.floor(s / 60)} м ${Math.round(s % 60)} с`;
}

function tokenFromEnvOrGh() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", shell: IS_WIN });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/**
 * Коды отказов СВЯЗИ (не ответа сервера). Первый запрос к GitHub после долгого
 * полного прогона уходит по keep-alive-соединению, которое за 35 минут умерло, и
 * встроенный fetch Node отвергает обещание ещё до ответа. Девять остановок ship
 * 07.10.2026 — две из них ровно здесь, УЖЕ ПОСЛЕ зелёных 10174 тестов, то есть
 * час прогона терялся на пустом месте (разбор docs/handoff-2026-10-07-edit-policy-ship.md).
 */
const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Код отказа связи из любой глубины `cause`; null — это не отказ связи. */
export function networkErrorCode(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return e.code;
  }
  return null;
}

/** Ответы GitHub, которые имеет смысл просить снова (чтения). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function github(token, { owner, repo }, { fetchImpl = fetch, sleep, log = console.log } = {}) {
  const wait = sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  /**
   * `retries` — сколько РАЗ ПОВТОРИТЬ после отказа связи. По умолчанию повторяются
   * только чтения: повтор PUT .../merge опасен тем, что ответ мог потеряться уже
   * ПОСЛЕ вливания, и второй запрос вернул бы «не сливается» — остановку с ложным
   * «на сайт ничего не ушло». Для вливания повтора нет: этап 9 спрашивает GitHub,
   * влилось ли, и верит ответу, а не догадке.
   */
  const call = async (method, path, body, { retries = method === "GET" ? 3 : 0 } = {}) => {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(`https://api.github.com${path.replace("{repo}", `repos/${owner}/${repo}`)}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        const code = networkErrorCode(err);
        if (code === null) throw err;
        if (attempt >= retries) {
          const stop = new Stop(`GitHub ${method} ${path}: связь оборвалась (${code})`);
          stop.network = code;
          throw stop;
        }
        attempt += 1;
        log(`  связь с GitHub оборвалась (${code}), попытка ${attempt} из ${retries} через ${1.5 * attempt} с`);
        await wait(1500 * attempt);
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { message: text };
      }
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          attempt += 1;
          log(`  GitHub ответил ${res.status}, попытка ${attempt} из ${retries} через ${1.5 * attempt} с`);
          await wait(1500 * attempt);
          continue;
        }
        throw new Stop(`GitHub ${method} ${path} → ${res.status}: ${json?.message ?? text}`);
      }
      return json;
    }
  };
  return {
    call,
    graphql: (query, variables) => call("POST", "/graphql", { query, variables }, { retries: 2 }),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    const head = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 11);
    console.log(head.map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    return 0;
  }

  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Stop("это не папка репозитория");
  const root = top.stdout.trim();
  const { git, run } = makeRunner(root);
  const timings = [];
  const stage = (n, title) => console.log(`\n\x1b[1m── ${n}. ${title}\x1b[0m`);
  const done = (name, ms) => timings.push({ name, ms });
  const blockers = [];

  // ── 1. подготовка ──
  stage(1, "подготовка");
  const runtimeProblem = shipRuntimeProblem(process.platform, process.version);
  if (runtimeProblem) blockers.push(runtimeProblem);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "main" || branch === "HEAD") blockers.push(`ветка «${branch}»: выкатывается рабочая ветка правки, не main`);
  const dirty = git("status", "--porcelain");
  if (dirty) blockers.push("в рабочем дереве незакоммиченные правки — закоммить их: проверено будет дерево, а уедет коммит");
  const repo = parseRepo(git("remote", "get-url", "origin"));
  const token = tokenFromEnvOrGh();
  if (!token) blockers.push("нет доступа к GitHub: задай GH_TOKEN или войди `gh auth login`");
  console.log(`  ветка ${branch}, репозиторий ${repo.owner}/${repo.repo}`);

  const r0 = run("git", ["fetch", "origin", "main"]);
  if (r0.code !== 0) throw new Stop("git fetch origin main не прошёл");
  const mainSha = git("rev-parse", "refs/remotes/origin/main");
  console.log(`  main = ${mainSha.slice(0, 9)} — сводится, проверяется и вливается ровно он`);

  // Файлы правки относительно main (по merge-base — только своё, не чужое из main).
  const files = git("diff", "--name-only", `${mainSha}...HEAD`).split("\n").filter(Boolean);
  const scope = opts.full ? { full: true, why: "попросили --full" } : needsFullApiRun(files);
  // Полный прогон — в облаке GitHub, кроме явного --local-tests (GitHub недоступен).
  const cloud = !opts.localTests;
  const migrations = newMigrations(files);
  const modes = badModes(git("diff", "--raw", "--no-abbrev", `${mainSha}...HEAD`));
  for (const b of modes) blockers.push(`${b.kind}: ${b.path} — такое в main не пускаем`);
  console.log(`  файлов в правке: ${files.length}`);
  console.log(`  полный прогон тестов сервера: ${scope.full ? (cloud ? "да, в облаке GitHub" : "да, здесь") : "нет"} — ${scope.why}`);
  if (cloud && opts.cleanDb) console.log("  --clean-db в облаке не нужен: у каждой машины GitHub база и так новая");
  if (migrations.length) console.log(`  новые миграции: ${migrations.join(", ")}`);
  if (files.length === 0) blockers.push("правка пустая относительно main — выкатывать нечего");

  if (opts.dryRun) {
    console.log("\n\x1b[1m── план (сухой прогон: ничего не менялось)\x1b[0m");
    const plan = [
      `2. свести с main ${mainSha.slice(0, 9)} (scripts/sync-main.mjs --onto)`,
      "3. режимы 120000/160000 — " + (modes.length ? "КРАСНО" : "чисто"),
      cloud
        ? `4. prisma:generate; migrate deploy — на базах машин GitHub (своих миграций в правке: ${migrations.length})`
        : `4. prisma:generate и migrate deploy на тестовую базу (своих миграций в правке: ${migrations.length})`,
      `5. npm run precheck${scope.full ? " -- --no-tests (тесты дальше полным прогоном)" : " (с тестами, задетыми правкой)"}`,
      `6. тесты API — ${scope.full ? (cloud ? `полный прогон в облаке GitHub (${CLOUD_WORKFLOW}, ветка ${cloudBranch("<sha>")}), параллельно с precheck` : `полный прогон здесь${opts.cleanDb ? " на чистой базе" : ""}`) : "пропуск по правилу пачки"}`,
      `7. git push origin HEAD:${branch}`,
      `8. отметка: строка Ship-Verified для коммита (+ статус «${STATUS_CONTEXT}», где GitHub даёт)`,
      opts.noMerge ? "9. влить — НЕТ (--no-merge)" : "9. влить squash, если main всё ещё " + mainSha.slice(0, 9),
      "10. сверить дерево main с проверенным; разошлось — build:api, build:web, map:check на main",
    ];
    for (const p of plan) console.log(`  ${p}`);
    if (blockers.length) {
      console.error("\n\x1b[31m✘ Выкат остановится на подготовке:\x1b[0m");
      for (const b of blockers) console.error(`  • ${b}`);
      return 1;
    }
    console.log("\n\x1b[32m✔ Препятствий не видно.\x1b[0m");
    return 0;
  }

  if (blockers.length) throw new Stop(blockers.join("\n  • "));

  const gh = github(token, repo);
  let pr;
  if (opts.pr) pr = await gh.call("GET", `/{repo}/pulls/${opts.pr}`);
  else {
    const list = await gh.call("GET", `/{repo}/pulls?state=open&head=${repo.owner}:${encodeURIComponent(branch)}`);
    pr = list?.[0];
  }
  if (!pr || pr.state !== "open") throw new Stop(`нет открытой правки для ветки ${branch} — открой её (можно черновиком)`);
  if (pr.head.ref !== branch) throw new Stop(`правка #${pr.number} из ветки ${pr.head.ref}, а здесь ${branch}`);
  if (pr.base.ref !== "main") throw new Stop(`правка #${pr.number} вливается в ${pr.base.ref}, а не в main`);
  console.log(`  правка #${pr.number}: ${pr.title}`);

  // ── 2. свести ──
  stage(2, `свести с main ${mainSha.slice(0, 9)}`);
  let r = run(process.execPath, [join(root, "scripts", "sync-main.mjs"), `--onto=${mainSha}`]);
  done("свести с main", r.ms);
  if (r.code !== 0) throw new Stop("сведение с main не прошло (вывод выше)");
  const behind = Number(git("rev-list", "--count", `HEAD..${mainSha}`));
  if (behind !== 0) throw new Stop(`после сведения ветка всё ещё отстаёт от main на ${behind}`);

  // После сведения список файлов тот же по смыслу, но режимы проверяем ещё раз: слияние могло принести.
  stage(3, "режимы файлов (ссылки 120000, вложенные репозитории 160000)");
  const modesAfter = badModes(git("diff", "--raw", "--no-abbrev", `${mainSha}...HEAD`));
  if (modesAfter.length) throw new Stop(modesAfter.map((b) => `${b.kind}: ${b.path}`).join("; "));
  console.log("  чисто");

  // С этого момента проверяется ровно эта вершина и это дерево (OPS10): перед отправкой
  // сверяем, что их никто не подменил, а пушим и подписываем именно записанные.
  const verified = snapshotState(git);
  console.log(`  проверяется ${verified.head.slice(0, 9)} (дерево ${verified.tree.slice(0, 9)})`);

  // Облачный прогон стартует ЗДЕСЬ, до миграций и precheck: машины GitHub
  // работают, пока эта машина собирает и проверяет. Ветка и прогон убираются в
  // любом исходе (state.cleanup зовётся и при остановке).
  let cloudRun = null;
  if (cloud) cloudRun = startCloudTests({ gh, run, repo, sha: verified.head,
    branch: scope.full ? cloudBranch(verified.head) : sourceBranch(verified.head) });

  // ── 4. миграции ──
  stage(4, cloud ? "сборка и проверка исходников на GitHub" : "клиент Prisma и миграции тестовой базы");
  const apiDir = join(root, "apps", "api");
  const testEnv = {};
  if (opts.cleanDb && scope.full && !cloud) {
    const c = spawnSync("npx", ["tsx", "tests/makeCleanDb.ts"], {
      cwd: apiDir,
      encoding: "utf8",
      shell: needsShell("npx"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (c.status !== 0) throw new Stop("не удалось создать чистую базу (вывод выше)");
    testEnv.DATABASE_URL = c.stdout.trim().split("\n").pop();
    console.log("  прогон пойдёт на новой пустой базе; миграции накатываются на неё целиком");
  }
  // ВСЕГДА, а не только при миграциях в самой правке: сведение с main приносит
  // ЧУЖИЕ миграции (24.09: #892 с search_console), и тестовая база без них
  // краснеет сотнями файлов не по вине правки. migrate deploy идемпотентен —
  // применённое пропускает за секунду.
  // Клиент Prisma лежит вне git (apps/api/src/generated) и после сведения с main
  // может отстать от схемы: сборка и тесты тогда идут по старому клиенту.
  // Именно npm run prisma:generate — `npx prisma generate` из корня молча не
  // перегенерирует (tests-shared-db-flake-classes).
  if (!cloud) {
    r = run("npm", ["run", "prisma:generate"]);
    done("prisma generate", r.ms);
    if (r.code !== 0) throw new Stop("npm run prisma:generate не прошёл");
  }
  if (cloud) {
    // Тестовая база этой машины в облачном режиме не нужна вовсе: precheck идёт
    // с --no-tests, полный прогон — на базах машин GitHub.
    console.log("  тестовая база здесь не нужна — полный прогон идёт в облаке");
  } else {
    r = run("npx", ["prisma", "migrate", "deploy"], { cwd: apiDir, env: testEnv });
    done("migrate deploy (тестовая база)", r.ms);
    if (r.code !== 0) throw new Stop("prisma migrate deploy на тестовую базу не прошёл");
  }

  // ── 5. precheck ──
  stage(5, "npm run precheck");
  const preArgs = ["scripts/precheck.mjs", `--base=${mainSha}`, ...(scope.full ? ["--no-tests"] : [])];
  if (cloud) {
    console.log("  precheck и тесты команды выката проверяются на GitHub для того же sha");
  } else {
    r = run(process.execPath, preArgs, { env: testEnv });
    done("precheck", r.ms);
    if (r.code !== 0) throw new Stop("precheck красный (сводка выше)");
  }

  // ── 6. полный прогон ──
  stage(6, cloud ? (scope.full ? "тесты сервера, полный прогон в облаке GitHub" : "проверки исходников в облаке GitHub") : "тесты сервера, полный прогон");
  let apiTests = 0;
  if (cloud) {
    const started = Date.now();
    apiTests = scope.full
      ? await waitCloudTests({ gh, repo, token, sha: verified.head, cloudRun })
      : await waitSourceChecks({gh,sha:verified.head,cloudRun});
    done(scope.full ? "test:api полный (облако)" : "precheck (облако)", Date.now() - started);
    await state.cleanup?.();
    console.log(scope.full ? `  тестов ${apiTests}, упало 0` : `  precheck пройден; ${scope.why}`);
  } else if (scope.full) {
    const report = join(mkdtempSync(join(tmpdir(), "rh-ship-")), "api-tests.json");
    r = run("npx", ["tsx", "tests/runParallel.ts", `--report=${report}`], { cwd: apiDir, env: testEnv });
    done("test:api полный", r.ms);
    if (!existsSync(report)) throw new Stop("полный прогон не оставил отчёта — считать его пройденным нельзя");
    const rep = JSON.parse(readFileSync(report, "utf8"));
    apiTests = requireFullApiRunPassed(r.code, rep);
    console.log(`  тестов ${apiTests}, упало ${rep.numFailedTests}, наборов с ошибкой ${rep.numFailedTestSuites}`);
  } else console.log(`  пропущен: ${scope.why}`);

  const drift = stateDrift(verified, snapshotState(git));
  if (drift.length) {
    throw new Stop(
      "пока шли проверки, проверяемое изменилось, отправлять нельзя:\n  • " +
        drift.join("\n  • ") +
        "\nНе работай в этом дереве во время ship (отдельный worktree), и запусти его заново",
    );
  }
  const headSha = verified.head;

  // ── 7. отправить ──
  stage(7, `отправить ветку ${branch}`);
  // Пушим записанную вершину, а не «HEAD сейчас».
  r = run("git", ["push", "origin", `${headSha}:refs/heads/${branch}`]);
  if (r.code !== 0) {
    throw new Stop(
      "GitHub не принял ветку: там есть коммиты, которых нет здесь. `git pull origin " + branch + "` и ship заново",
    );
  }
  // GitHub обновляет голову правки не мгновенно — ждём, пока увидит наш sha.
  for (let i = 0; i < 15; i++) {
    pr = await gh.call("GET", `/{repo}/pulls/${pr.number}`);
    if (pr.head.sha === headSha) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (pr.head.sha !== headSha) throw new Stop(`GitHub видит в правке ${pr.head.sha.slice(0, 9)}, а проверен ${headSha.slice(0, 9)}`);

  // ── 8. отметка ──
  // Отметок две. ГЛАВНАЯ — строка Ship-Verified в сообщении squash-коммита (её
  // кладёт этап 9): она едет вместе с кодом, и сервер выката (ops/auto-deploy.sh,
  // crm_ship_verified) берёт на сайт только вершину main, у которой эта строка
  // совпадает с её деревом. Выбор Dan 24.09: проверять отметку на сервере.
  // Вторая — статус GitHub «проверено» для глаз в интерфейсе. Облачные сессии
  // Claude его ставить не могут (прокси запрещает запись в /statuses, 403,
  // проверено 24.09), поэтому его отсутствие выкат не останавливает: сторож на
  // сервере от GitHub не зависит.
  stage(8, `отметка «${STATUS_CONTEXT}» на ${headSha.slice(0, 9)}`);
  const trailer = shipTrailer({ tree: verified.tree, mainSha, apiTests, full: scope.full });
  console.log(`  строка в коммите: ${trailer}`);
  try {
    await gh.call("POST", `/{repo}/statuses/${headSha}`, {
      state: "success",
      context: STATUS_CONTEXT,
      description: statusDescription({ mainSha, apiTests, full: scope.full }),
    });
    console.log("  статус GitHub поставлен");
  } catch (err) {
    console.log(`  статус GitHub не поставлен (${err.message}); на сайт пускает строка в коммите`);
  }

  const summary = () => {
    console.log("\n\x1b[1m── время\x1b[0m");
    for (const t of timings) console.log(`  ${t.name.padEnd(32)} ${fmt(t.ms)}`);
  };

  if (opts.noMerge) {
    summary();
    console.log(`\n\x1b[32m✔ Правка #${pr.number} проверена (${headSha.slice(0, 9)} на main ${mainSha.slice(0, 9)}).\x1b[0m`);
    console.log("Влить: npm run ship ещё раз без --no-merge (сведёт заново, если main ушёл).");
    return 0;
  }

  // ── 9. влить ──
  stage(9, "влить");
  const liveMain = (await gh.call("GET", "/{repo}/git/ref/heads/main")).object.sha;
  if (liveMain !== mainSha) {
    throw new Stop(
      `main ушёл вперёд (${mainSha.slice(0, 9)} → ${liveMain.slice(0, 9)}) пока шла проверка. ` +
        "Проверенное на старом main не вливаем: npm run ship заново",
    );
  }
  if (pr.draft) {
    // Облачная сессия ходит к GitHub через прокси без GraphQL, у неё свой путь
    // снятия черновика; на ноутбуке — обычный GraphQL.
    try {
      await gh.call("POST", `/{repo}/pulls/${pr.number}/ccr/ready_for_review`, {});
    } catch {
      await gh.graphql(
        "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        { id: pr.node_id },
      );
    }
    console.log("  черновик снят");
  }
  // Повтора у вливания нет нарочно: ответ мог потеряться уже ПОСЛЕ того, как
  // GitHub влил, и второй PUT вернул бы «не сливается» — остановка сказала бы
  // «на сайт ничего не ушло», когда правка уже уехала. Поэтому при обрыве связи
  // спрашиваем GitHub, что он на самом деле сделал.
  let merged;
  try {
    merged = await gh.call("PUT", `/{repo}/pulls/${pr.number}/merge`, {
      merge_method: "squash",
      sha: headSha,
      commit_title: `${pr.title} (#${pr.number})`,
      commit_message: trailer,
    });
  } catch (err) {
    if (!err.network) throw err;
    console.log(`  ${err.message} — спрашиваю GitHub, влилось ли`);
    const after = await gh.call("GET", `/{repo}/pulls/${pr.number}`);
    if (after?.merged && after.merge_commit_sha) {
      merged = { merged: true, sha: after.merge_commit_sha };
      console.log("  влилось до обрыва");
    } else {
      throw new Stop(
        `${err.message}; GitHub говорит, что правка НЕ влита — npm run ship заново (ничего на сайт не ушло)`,
      );
    }
  }
  if (!merged?.merged) throw new Stop(`GitHub не влил: ${merged?.message ?? "без объяснения"}`);
  state.mergedSha = merged.sha;
  console.log(`  влито: main ${merged.sha.slice(0, 9)}. GitHub-проверки пройдены.`);

  // ── 10. после ──
  stage(10, "main после вливания");
  run("git", ["fetch", "origin", "main"]);
  const newMain = git("rev-parse", "refs/remotes/origin/main");
  const sameTree = git("rev-parse", `${newMain}^{tree}`) === verified.tree;
  if (sameTree) {
    console.log(`  дерево main ${newMain.slice(0, 9)} совпадает с проверенным побайтно — сборки и карта уже зелёные на нём`);
  } else {
    console.log(
      "  \x1b[33mдерево main отличается от проверенного\x1b[0m (кто-то влил между проверкой и вливанием) — " +
        "сервер такую вершину НЕ выкатит: строка Ship-Verified не совпадёт с деревом. Собираю main; дальше — npm run ship следующей правкой",
    );
    git("checkout", "--detach", newMain);
    const post = [
      ["build:api", ["run", "build:api"]],
      ["build:web", ["run", "build:web"]],
      ["map:check", ["run", "map:check"]],
    ];
    let red = null;
    for (const [name, args] of post) {
      const x = run("npm", args);
      done(`main: ${name}`, x.ms);
      if (x.code !== 0) {
        red = name;
        break;
      }
    }
    git("checkout", branch);
    if (red) throw new Stop(`на main красный ${red} — чинить отдельной правкой вперёд очереди`);
  }
  if (migrations.length) {
    console.log(
      "\n  \x1b[33mВ правке новые миграции.\x1b[0m На сайте их накатит выкат сам (ops/deploy.sh). " +
        "Соседним сессиям перед полным прогоном: cd apps/api && npx prisma migrate deploy",
    );
  }
  summary();
  console.log(`\n\x1b[32m✔ Правка #${pr.number} на main (${newMain.slice(0, 9)}).\x1b[0m`);
  return 0;
}

// Запуск как команды (а не импорт из теста).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Встроенный fetch Node не читает HTTPS_PROXY без NODE_USE_ENV_PROXY=1 (облачные
  // сессии ходят наружу только через прокси). Перезапуск с флагом — один раз.
  if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
    const again = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: "inherit",
      env: { ...process.env, NODE_USE_ENV_PROXY: "1", NODE_NO_WARNINGS: "1" },
    });
    process.exit(again.status ?? 1);
  }
  main().finally(() => state.cleanup?.()).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof Stop) {
        console.error(`\n\x1b[31m✘ Выкат остановлен:\x1b[0m\n  • ${err.message}`);
        console.error(
          state.mergedSha
            ? `Правка УЖЕ влита (main ${state.mergedSha.slice(0, 9)}) и уезжает на сайт — красное выше чинить сразу.`
            : "На сайт ничего не ушло.",
        );
      } else console.error(err);
      process.exit(1);
    },
  );
}

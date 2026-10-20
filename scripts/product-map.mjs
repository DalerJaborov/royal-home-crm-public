#!/usr/bin/env node
/**
 * КАРТА ПРОДУКТА — строится ИЗ КОДА, не пишется руками.
 *
 * ЗАЧЕМ. Карта, написанная по памяти, врёт уже через неделю: экраны добавляют,
 * маршруты переименовывают, задания по расписанию заводят, а документ остаётся
 * прежним. Поэтому здесь нет ни одной строки, набранной человеком: всё, что
 * попадает в `docs/product-map.md`, вычитано из исходников этого репозитория.
 * Чего нет в коде — в карте не появится.
 *
 * ЧТО СОБИРАЕТСЯ:
 *   1. Экраны       — маршруты из `apps/web/src/App.tsx` + пункты меню из
 *                     `apps/web/src/lib/navigation.ts`.
 *   2. Сервер       — модули, подключённые в `apps/api/src/app.ts`, и число
 *                     адресов внутри каждого.
 *   3. Расписание   — вызовы `scheduleTracked` в `apps/api/src/cron.ts`.
 *   4. Фон. задания — файлы `apps/api/src/jobs/*` с `registerJobHandler`.
 *   5. Связи        — какие адреса сервера реально зовёт интерфейс
 *                     (вызовы `api("/...")` во фронте).
 *   6. Внешние      — ключи `process.env` в `apps/api/src`, сведённые в
 *      сервисы       известные группы (WhatsApp, Instagram, телефония и т.д.).
 *
 * ЧЕГО НЕ УМЕЕТ (и не должен): понимать пути, собранные из переменных, и
 * догадываться о намерении. Ложное «не используется» здесь дешевле пропуска —
 * это список на посмотреть глазами, а не приговор.
 *
 * Запуск:
 *   node scripts/product-map.mjs          — перезаписать docs/product-map.md
 *   node scripts/product-map.mjs --check  — только проверить, что файл совпадает
 *                                           с кодом (код возврата 1, если нет)
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { collectPageBindings } from "./product-map-page-bindings.mjs";
import { endpoints as flowEndpoints } from "./product-flows.mjs";

// Путь в карте — всегда через «/»: на Windows relative() отдаёт «\», и карта,
// собранная там, расходилась с проверкой в CI на Linux (21.09.2026). ROOT
// объявлен ниже — функция читает его при вызове, не при объявлении.
const repoPath = (f) => relative(ROOT, f).split(sep).join("/");

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, "apps/web/src");
const API_SRC = join(ROOT, "apps/api/src");
const OUT = join(ROOT, "docs/product-map.md");
const OUT_JSON = join(ROOT, "docs/product-map.json");

// На Windows-раннере (checkout без .gitattributes-исключения, редактирование
// файла локально в notepad/VS Code с автопереводом строк) файл на диске может
// прийти с `\r\n`, а генератор всегда пишет чистый `\n`. Раньше сверка
// (`current !== text`) была побайтной и красила любой такой файл как «карта
// отстала», хотя код и карта совпадают — расходится только перевод строки.
// Нормализуем здесь, а не полагаемся только на .gitattributes: это защищает
// механизм сверки, даже если правило eol для конкретного пути забыли добавить.
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const LABELS = JSON.parse(read(join(ROOT, "docs/product-map-labels.json")));

/* Клиент Prisma лежит в исходниках (apps/api/src/generated) и появляется только
 * после `prisma generate` — на сервере проверок он есть, на машине разработчика нет. */
const SKIP_DIR = new Set(["generated", "node_modules", "dist", "build", ".turbo"]);

/* Порядок сортировки НЕ через localeCompare: он зависит от сборки ICU в Node, и
 * карта, собранная на машине разработчика, расходилась с собранной на сервере
 * проверок при одном и том же коде. Сравнение по кодам символов одинаково везде. */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);


function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  /* Порядок выдачи readdir зависит от файловой системы: на моей машине один,
   * на сервере проверок другой — и собранная карта расходилась сама с собой.
   * Сортировка делает сборку повторяемой где угодно. */
  for (const name of [...readdirSync(dir)].sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIR.has(name) || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/* ─────────────────────────── 1. Экраны ─────────────────────────── */

function collectScreens() {
  const src = read(join(WEB_SRC, "App.tsx"));

  // Statement-scoped AST resolution cannot steal a following inline import.
  const fileOf = new Map([...collectPageBindings(join(WEB_SRC, "App.tsx"), { webRoot: WEB_SRC })]
    .map(([name, file]) => [name, relative(ROOT, file).split(sep).join("/")]));

  const screens = [];
  for (const m of src.matchAll(/<Route\s+([\s\S]{0,400}?)\/?>/g)) {
    const attrs = m[1];
    const path = attrs.match(/path="([^"]*)"/)?.[1];
    if (path === undefined) continue;
    const comp = attrs.match(/element=\{<(\w+)/)?.[1] ?? "";
    const redirect = /<Navigate\s+to="([^"]+)"/.exec(attrs)?.[1] ?? null;
    screens.push({
      path: path.startsWith("/") ? path : `/${path}`,
      component: comp,
      file: fileOf.get(comp) ?? "",
      redirect,
    });
  }
  // `<Route index element={<Dashboard />} />` — корень, у него нет path=
  if (/<Route\s+index\s+element=\{<(\w+)/.test(src)) {
    const comp = src.match(/<Route\s+index\s+element=\{<(\w+)/)[1];
    screens.unshift({ path: "/", component: comp, file: fileOf.get(comp) ?? "", redirect: null });
  }
  screens.sort((a, b) => byCode(a.path, b.path));
  return screens;
}

function collectNav() {
  const src = read(join(WEB_SRC, "lib/navigation.ts"));
  const items = [];
  // Пункты объявлены объектами { to: "/x", ..., label: "Y", ..., group: "z" }
  for (const m of src.matchAll(/\{[^{}]*?to:\s*"([^"]+)"[\s\S]{0,300}?\}/g)) {
    const chunk = m[0];
    const to = m[1];
    const label = chunk.match(/label:\s*"([^"]+)"/)?.[1]
      ?? chunk.match(/label:\s*can\("[^"]+"\)\s*\?\s*"([^"]+)"/)?.[1]
      ?? "";
    const group = chunk.match(/group:\s*"([^"]+)"/)?.[1] ?? "";
    const gate = chunk.match(/can\("([\w.]+)"\)/)?.[1] ?? "";
    if (!label) continue;
    items.push({ to, label, group, gate });
  }
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.to}|${i.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ─────────────────────────── 2. Сервер ─────────────────────────── */

function collectApiModules() {
  const appSrc = read(join(API_SRC, "app.ts"));

  const fileOfRouter = new Map();
  for (const m of appSrc.matchAll(/import\s+\{?\s*([\w\s,]+?)\s*\}?\s+from\s+"\.\/(routes\/[\w/.]+?)\.js"/g)) {
    for (const name of m[1].split(",").map((s) => s.trim().split(" as ").pop())) {
      if (name) fileOfRouter.set(name, `apps/api/src/${m[2]}.ts`);
    }
  }

  const mounts = [];
  for (const m of appSrc.matchAll(/app\.use\(\s*"(\/api\/v1[^"]*)"\s*,\s*([\s\S]{0,120}?)\)\s*;/g)) {
    const routers = [...m[2].matchAll(/\b(\w*[Rr]outer)\b/g)].map((x) => x[1]);
    for (const r of routers) {
      mounts.push({ mount: m[1], router: r, file: fileOfRouter.get(r) ?? "" });
    }
  }

  // Число адресов внутри модуля — из общего разбора `scripts/product-flows.mjs`,
  // чтобы две карты не расходились в счёте. Считать по одному файлу нельзя:
  // крупные модули (клиенты, объекты) разложены на вложенные роутеры, и адреса
  // из подпапок в этот файл не попадают.
  //
  // Ключ `top` у разбора — «файл::роутер» (`apps/api/src/routes/ads.ts::adsRouter`),
  // а не голое имя роутера. До 02.10.2026 здесь искали по голому имени, ни один
  // ключ не совпадал, и карта писала «Адресов сервера всего | 0» и по нулю у
  // каждого модуля (глубокая проверка 02.10.2026, строка сборщика). Сначала —
  // точное совпадение файла и роутера; если файл в app.ts записан иначе
  // (импорт папки `routes/clients/index`), — по имени роутера после «::».
  const perMount = new Map();
  for (const e of flowEndpoints) perMount.set(e.top, (perMount.get(e.top) ?? 0) + 1);
  const byRouterName = new Map();
  for (const [top, n] of perMount) {
    const name = top.split("::").pop();
    byRouterName.set(name, (byRouterName.get(name) ?? 0) + n);
  }
  for (const mo of mounts) mo.endpoints = perMount.get(`${mo.file}::${mo.router}`) ?? byRouterName.get(mo.router) ?? 0;
  return mounts;
}

/* ───────────────────── 3. Задачи по расписанию ───────────────────── */

function collectCron() {
  // Не только cron.ts: задачи, которым нужна память HTTP-процесса (телефония),
  // объявлены в index.ts и lib/telephony/* (28.09.2026, звонки робота). Сама
  // обёртка scheduleTracked живёт в lib/cronHeartbeat.ts — её пропускаем.
  const out = [];
  for (const f of walk(API_SRC)) {
    if (!/\.ts$/.test(f) || /[\\/]generated[\\/]/.test(f) || /cronHeartbeat\.ts$/.test(f)) continue;
    const src = read(f);
    if (!src.includes("scheduleTracked(")) continue;
    for (const m of src.matchAll(/scheduleTracked\(\s*(?:\/\*[\s\S]*?\*\/\s*)?"([^"]+)"\s*,\s*"([^"]+)"/g)) {
      if (!out.some((x) => x.id === m[1])) out.push({ id: m[1], expr: m[2] });
    }
    // Перенос строки между именем и выражением (scheduleTracked(\n  "id",\n  "expr")
    for (const m of src.matchAll(/scheduleTracked\(\s*\n\s*"([^"]+)"\s*,\s*\n?\s*"([^"]+)"/g)) {
      if (!out.some((x) => x.id === m[1])) out.push({ id: m[1], expr: m[2] });
    }
  }
  out.sort((a, b) => byCode(a.id, b.id));
  return out;
}

function collectJobs() {
  const dir = join(API_SRC, "jobs");
  const out = [];
  for (const f of walk(dir)) {
    const s = read(f);
    if (!/JobHandler</.test(s)) continue;
    // Только тип самого задания — `type:` внутри объекта JobHandler. Раньше сюда
    // попадал любой `type: "..."` из файла (так в списке оказался мнимый SYSTEM).
    for (const m of s.matchAll(/:\s*JobHandler<[\s\S]{0,400}?type:\s*"([\w-]+)"/g)) {
      out.push({ type: m[1], file: repoPath(f) });
    }
  }
  const seen = new Set();
  return out.filter((j) => (seen.has(j.type) ? false : (seen.add(j.type), true)))
    .sort((a, b) => byCode(a.type, b.type));
}

/* ────────────────────── 5. Связи «экран → сервер» ────────────────────── */

function collectApiCalls() {
  const calls = new Map(); // путь (первый сегмент) → Set файлов
  for (const f of walk(WEB_SRC)) {
    const s = read(f);
    for (const m of s.matchAll(/\bapi[a-zA-Z]*[<(][\s\S]{0,40}?["'`]\/([\w-]+)/g)) {
      const seg = `/${m[1]}`;
      if (!calls.has(seg)) calls.set(seg, new Set());
      calls.get(seg).add(repoPath(f));
    }
  }
  return calls;
}

/* ──────────────────── 6. Внешние сервисы по ключам ──────────────────── */

const SERVICE_RULES = [
  ["WhatsApp, Instagram Direct, Messenger (Meta)", /^META_(APP|WA|IG|PAGE|VERIFY)/],
  ["Instagram Graph через прокси", /^IG_PROXY_/],
  ["Реклама Meta (рекламный кабинет)", /^META_(ADS|AD_ACCOUNT)/],
  ["Telegram", /^TELEGRAM_/],
  ["TikTok", /^TIKTOK_/],
  ["Телефония FreePBX / Asterisk", /^(PBX|AMI|ARI|ASTERISK|AUDIOSOCKET)_/],
  ["Голосовой ИИ на звонках (Gemini Live)", /^LIVE_VOICE_/],
  ["ИИ Google Gemini", /^GEMINI_/],
  ["Карты и геокодер (OpenStreetMap)", /^(NOMINATIM|GEOCODE)_/],
  ["Сайт royalhome.tj", /^(SITE_|WEBSITE_|CRM_PUBLIC_URL)/],
  ["Хранилище Cloudflare R2", /^R2_/],
  ["Пуш-уведомления", /^(VAPID_|PUSH_QUIET)/],
  ["Отчёты о резервных копиях", /^BACKUP_/],
  ["Бюджет Google Cloud", /^GOOGLE_BUDGET_/],
  ["Утренний отчёт наружу", /^(MORNING_REPORT|TEAM_REQUESTS)_/],
];

function collectExternal() {
  const found = new Map();
  for (const f of walk(API_SRC)) {
    const s = read(f);
    for (const m of s.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const key = m[1];
      const svc = SERVICE_RULES.find(([, re]) => re.test(key))?.[0];
      if (!svc) continue;
      if (!found.has(svc)) found.set(svc, { keys: new Set(), files: new Set() });
      found.get(svc).keys.add(key);
      found.get(svc).files.add(repoPath(f));
    }
  }
  return found;
}

/* ─────────────────────────── Отрисовка ─────────────────────────── */

let JSON_OUT = "";

function render() {
  const screens = collectScreens();
  const nav = collectNav();
  const modules = collectApiModules();
  const cron = collectCron();
  const jobs = collectJobs();
  const calls = collectApiCalls();
  const external = collectExternal();

  const navByPath = new Map(nav.map((n) => [n.to, n]));
  const L = [];
  const p = (s = "") => L.push(s);

  p("# Карта продукта Royal Home CRM");
  p();
  p("> **Этот файл собран программой из кода, руками его не правят.**");
  p("> Источник — `scripts/product-map.mjs`. Перестроить: `npm run map`.");
  p("> Проверить, что карта не отстала от кода: `npm run map:check`.");
  p("> Дат в файле нет намеренно: иначе он менялся бы каждый запуск и проверка");
  p("> «карта отстала» стала бы бессмысленной.");
  p();

  /* Сводка */
  p("## Коротко, цифрами");
  p();
  p("| Что | Сколько |");
  p("|---|---|");
  p(`| Экранов (адресов в интерфейсе) | ${screens.length} |`);
  p(`| Из них видно в меню | ${screens.filter((s) => navByPath.has(s.path)).length} |`);
  p(`| Модулей сервера | ${modules.length} |`);
  p(`| Адресов сервера всего | ${modules.reduce((a, m) => a + (m.endpoints ?? 0), 0)} |`);
  p(`| Задач по расписанию | ${cron.length} |`);
  p(`| Типов фоновых заданий | ${jobs.length} |`);
  p(`| Внешних сервисов | ${external.size} |`);
  p();

  /* Экраны */
  p("## 1. Экраны интерфейса");
  p();
  p("«В меню» — пункт есть в боковом меню или в нижней панели (`lib/navigation.ts`).");
  p("«Только по ссылке» — экран существует, но попасть на него можно лишь прямым адресом.");
  p();
  p("| Адрес | Экран | В меню | Файл |");
  p("|---|---|---|---|");
  for (const s of screens) {
    const n = navByPath.get(s.path);
    const where = s.redirect ? `переход на \`${s.redirect}\`` : n ? `**${n.label}**` : "только по ссылке";
    p(`| \`${s.path}\` | ${s.component || "—"} | ${where} | ${s.file ? `\`${s.file}\`` : "—"} |`);
  }
  p();

  p("### Пункты меню по складкам");
  p();
  p("| Складка | Пункт | Адрес | Кому видно |");
  p("|---|---|---|---|");
  for (const n of nav) p(`| ${n.group || "—"} | ${n.label} | \`${n.to}\` | ${n.gate ? `право \`${n.gate}\`` : "всем"} |`);
  p();

  /* Сервер */
  p("## 2. Модули сервера");
  p();
  p("«Зовёт интерфейс» — во фронте найден хотя бы один вызов по этому адресу.");
  p("Пусто — модуль работает сам (вебхуки, расписание) либо к нему никто не обращается.");
  p();
  p("| Адрес | Что делает | Адресов внутри | Зовёт интерфейс | Файл |");
  p("|---|---|---|---|---|");
  for (const m of modules) {
    const seg = `/${m.mount.replace("/api/v1/", "").split("/")[0]}`;
    const used = calls.get(seg);
    const label = LABELS.api[m.mount] ?? "**без подписи**";
    p(`| \`${m.mount}\` | ${label} | ${m.endpoints ?? "—"} | ${used ? `да (${used.size} мест)` : "нет"} | ${m.file ? `\`${m.file}\`` : "—"} |`);
  }
  p();

  /* Расписание */
  p("## 3. Что сервер делает сам, по часам");
  p();
  p("| Имя задачи | Расписание | Что делает |");
  p("|---|---|---|");
  for (const c of cron) p(`| \`${c.id}\` | \`${c.expr}\` | ${LABELS.cron[c.id] ?? "**без подписи**"} |`);
  p();

  p("### Фоновые задания (очередь)");
  p();
  p("| Тип | Файл |");
  p("|---|---|");
  for (const j of jobs) p(`| \`${j.type}\` | \`${j.file}\` |`);
  p();

  /* Внешние */
  p("## 4. Внешние сервисы");
  p();
  p("Определяются по ключам настроек, которые сервер читает из окружения.");
  p();
  p("| Сервис | Ключей настроек | Где используется (файлов) |");
  p("|---|---|---|");
  for (const [svc, info] of [...external].sort((a, b) => byCode(a[0], b[0]))) {
    p(`| ${svc} | ${info.keys.size} | ${info.files.size} |`);
  }
  p();

  const missingCron = cron.filter((c) => !LABELS.cron[c.id]).map((c) => c.id);
  const missingApi = modules.filter((m) => !LABELS.api[m.mount]).map((m) => m.mount);
  p("## 5. Без человеческой подписи");
  p();
  p("Появилось в коде, но не описано в `docs/product-map-labels.json`. Пустые списки —");
  p("норма; непустые значат, что функция завелась, а объяснить её никто не удосужился.");
  p();
  p(`- Задач по расписанию: ${missingCron.length ? missingCron.map((x) => `\`${x}\``).join(", ") : "нет"}`);
  p(`- Модулей сервера: ${missingApi.length ? missingApi.map((x) => `\`${x}\``).join(", ") : "нет"}`);
  p();

  const data = {
    screens: screens.map((s) => ({ ...s, nav: navByPath.get(s.path) ?? null })),
    nav,
    modules: modules.map((m) => ({
      ...m,
      label: LABELS.api[m.mount] ?? null,
      usedBy: [...(calls.get(`/${m.mount.replace("/api/v1/", "").split("/")[0]}`) ?? [])].length,
    })),
    cron: cron.map((c) => ({ ...c, label: LABELS.cron[c.id] ?? null })),
    jobs,
    external: [...external].map(([name, i]) => ({ name, keys: i.keys.size, files: i.files.size })).sort((a, b) => byCode(a.name, b.name)),
  };
  JSON_OUT = JSON.stringify(data, null, 2) + "\n";
  return L.join("\n") + "\n";
}

const text = render();

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? read(OUT) : "";
  const currentJson = existsSync(OUT_JSON) ? read(OUT_JSON) : "";
  if (current !== text || currentJson !== JSON_OUT) {
    console.error("Карта продукта отстала от кода: docs/product-map.md не совпадает с тем, что сейчас в исходниках.");
    console.error("Перестроить: npm run map");
    process.exit(1);
  }
  console.log("Карта продукта совпадает с кодом.");
} else {
  writeFileSync(OUT, text);
  writeFileSync(OUT_JSON, JSON_OUT);
  console.log(`Карта записана: ${relative(ROOT, OUT)} и ${relative(ROOT, OUT_JSON)}`);
}

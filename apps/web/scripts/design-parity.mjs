/**
 * СВЕРОЧНЫЙ СКРИПТ РЕДИЗАЙНА: «ПРИЁМКА ПО ЧИСЛАМ, А НЕ НА ГЛАЗ» (06.10.2026).
 *
 * Снимает каждый экран на ПК (1440×900) и на телефоне (390×844, касание,
 * масштаб 2) по каждой роли, считает метрики и сравнивает с прошлым прогоном.
 * Подробности, пороги и смысл каждой метрики: docs/design/parity/README.md.
 *
 * Запуск (из apps/web; стенд уже поднят — `node scripts/agent-stand.mjs serve …`):
 *   AUDIT_BASE=http://localhost:5284 node scripts/design-parity.mjs \
 *     [--routes /,/clients] [--roles agent,director] [--out docs/design/parity/2026-10-06] \
 *     [--baseline <папка>] [--theme light|night] [--sizes desktop,mobile] \
 *     [--mock | --live-ui] [--no-fail] [--pixel-threshold 24]
 * --live-ui: isolated QA 5294, or 5305 with AUDIT_ISOLATED_SEED=1;
 * real UI login/SW and theme restoration. Owner preview 5284 is excluded.
 *
 * Без `--mock` нужен настоящий API за Vite-прокси (вход по телефону и паролю
 * сида). С `--mock` API подменяется фикстурами `lib/mobile-fixtures.mjs` —
 * хватает одного Vite, но данные выдуманные, и числа сравнимы только с такими
 * же прогонами.
 *
 * Код возврата 1: есть ошибки консоли, свидетель кадра не сошёлся, либо доля
 * текста «телефон / ПК» меньше 0,5 при непустом тексте на ПК (`--no-fail`
 * отключает). Код 2: неверные аргументы.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverRoutes,
  resolveParams,
  slugOf,
  loginApi,
  seedStorage,
  makeBody,
  withRequired,
  scrollMain,
  probe,
  staticMetrics,
  mergeProbes,
  witness,
  diffPercent,
  previousRun,
} from "./lib/parity-core.mjs";
import { body as mockBody, agent as mockAgent } from "./lib/mobile-fixtures.mjs";
import { assertLiveTarget, loginLive } from "./lib/parity-live-session.mjs";
import { compareResponsiveText, hasResponsiveTextLoss, needsMatchingConversationCapture } from "./lib/parity-text-comparison.mjs";
import { interfaceStyleProbe } from "./lib/interface-style-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const repoRoot = path.resolve(webRoot, "../..");
const parityRoot = path.join(repoRoot, "docs/design/parity");

/* ───────────────────────────── аргументы ───────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

const KNOWN = new Set(["routes", "roles", "out", "baseline", "theme", "sizes", "mock", "live-ui", "no-fail", "pixel-threshold", "help"]);
for (const a of argv.filter((x) => x.startsWith("--"))) {
  if (!KNOWN.has(a.slice(2))) {
    console.error(`неизвестный флаг ${a}. Известные: ${[...KNOWN].map((k) => "--" + k).join(" ")}`);
    process.exit(2);
  }
}
if (flag("help")) {
  console.log("см. шапку файла и docs/design/parity/README.md");
  process.exit(0);
}

const BASE = (process.env.AUDIT_BASE ?? "http://localhost:5173").replace(/\/$/, "");
const MOCK = flag("mock");
const LIVE_UI = flag("live-ui");
if (LIVE_UI) {
  assertLiveTarget(BASE);
  if (MOCK) throw new Error("--live-ui cannot be combined with --mock");
}
const ROLES = list(opt("roles")) ?? ["agent", "director"];
const THEME = opt("theme", "light");
const THRESHOLD = Number(opt("pixel-threshold", "24"));
const SIZES_ARG = list(opt("sizes")) ?? ["desktop", "mobile"];
const today = new Date().toISOString().slice(0, 10);
const outArg = opt("out", path.join("docs/design/parity", today));
const OUT = path.isAbsolute(outArg) ? outArg : path.resolve(repoRoot, outArg);
const NO_FAIL = flag("no-fail");

if (!["light", "night"].includes(THEME)) {
  console.error(`--theme: light или night, получено «${THEME}»`);
  process.exit(2);
}
for (const s of SIZES_ARG) {
  if (!["desktop", "mobile"].includes(s)) {
    console.error(`--sizes: desktop и/или mobile, получено «${s}»`);
    process.exit(2);
  }
}

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const EXPECT_THEME = THEME === "night" ? "royal-home-2026-night" : "royal-home-2026-light";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── маршруты ───────────────────────────── */

/**
 * Git Bash на Windows превращает аргумент `/` в `C:/Program Files/Git/` и
 * `/clients` в `C:/Program Files/Git/clients` ещё до запуска node. Разворачиваем
 * обратно; `root` и `index` означают главную. Надёжный способ без этого:
 * `MSYS_NO_PATHCONV=1` или PowerShell.
 */
function normalizeRoute(r) {
  const mangled = /^[A-Za-z]:[\\/]+Program Files[\\/]+Git(?:[\\/]+(.*))?$/.exec(r);
  if (mangled) return `/${(mangled[1] ?? "").replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
  if (r === "root" || r === "index") return "/";
  return r.startsWith("/") ? r : `/${r}`;
}

let routeList;
const skipped = [];
{
  const found = discoverRoutes(path.join(webRoot, "src/App.tsx"));
  for (const s of found.skipped) skipped.push({ ...s, role: "*" });
  const asked = list(opt("routes"));
  routeList = asked ? asked.map(normalizeRoute) : found.routes;
}

/* ───────────────────────────── шторка (R2) ───────────────────────────── */

/**
 * Открывает ОДНУ шторку/меню на экране (кнопка с `aria-haspopup`, `data-opens-sheet`
 * или текстом «Фильтры/Ещё/Изменить»), снимает кадр `__sheet.png`, считает те же
 * метрики наезда/обрезки/вылета и закрывает Esc. Если маршрут сменился (кнопка
 * оказалась ссылкой) — возвращаемся назад и шторку не считаем.
 */
async function probeSheet(page, slug, role, sizeKey, frames) {
  try {
    await page.evaluate(scrollMain, { to: "top" });
    await sleep(150);
    const startUrl = page.url();
    const trigger = await page.evaluateHandle((liveUi) => {
      const vh = window.innerHeight;
      const ok = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled;
      };
      const cands = [...document.querySelectorAll("button, [role=button]")].filter(ok);
      if (liveUi) return cands.find((el) => /^Фильтры$/.test((el.getAttribute("aria-label") || el.textContent || "").trim())) ?? null;
      const byAttr = cands.find((el) => el.hasAttribute("data-opens-sheet") || (el.getAttribute("aria-haspopup") && el.getAttribute("aria-haspopup") !== "false"));
      if (byAttr) return byAttr;
      return cands.find((el) => /^\s*(Фильтры|Ещё|Изменить)\s*$/.test(el.textContent || "")) ?? null;
    }, LIVE_UI);
    const el = trigger.asElement();
    if (!el) return { opened: false };
    const label = ((await el.textContent()) || (await el.getAttribute("aria-label")) || "").replace(/\s+/g, " ").trim().slice(0, 30);
    await el.click({ timeout: 3000 });
    await sleep(600);
    if (page.url() !== startUrl) {
      await page.goBack({ waitUntil: "load", timeout: 15000 }).catch(() => {});
      return { opened: false, trigger: label, note: "кнопка сменила маршрут" };
    }
    const file = `${slug}__${role}__${sizeKey}__sheet.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    frames.push(file);
    const m = mergeProbes([await page.evaluate(probe, { sheet: true })]);
    const interfaceStyles = await page.evaluate(interfaceStyleProbe);
    await page.keyboard.press("Escape");
    await sleep(200);
    return {
      opened: true,
      trigger: label,
      interfaceStyles,
      overlapCount: m.overlapCount,
      overlapDetail: m.overlapDetail,
      clippedTextCount: m.clippedTextCount,
      clippedTextDetail: m.clippedTextDetail,
      outOfBoundsCount: m.outOfBoundsCount,
      outOfBoundsDetail: m.outOfBoundsDetail,
    };
  } catch (e) {
    return { opened: false, note: `сбой шторки: ${String(e.message ?? e).split("\n")[0].slice(0, 120)}` };
  }
}

/* ───────────────────────────── прогон одной ячейки ───────────────────────────── */

const unmocked = new Set();
const mockHandler = withRequired(makeBody([mockBody], unmocked));

async function openContext(browser, role, sizeKey) {
  const size = SIZES[sizeKey];
  const ctx = await browser.newContext({
    ...size,
    reducedMotion: "reduce",
    serviceWorkers: MOCK ? "block" : "allow",
    colorScheme: THEME === "night" ? "dark" : "light",
    permissions: ["notifications"],
    locale: "ru-RU",
  });
  let auth;
  if (LIVE_UI) {
    try {
      const session = await loginLive(ctx, BASE, role, THEME);
      return { ctx, ...session };
    } catch (error) {
      await ctx.close();
      throw error;
    }
  }
  if (MOCK) {
    auth = { agent: mockAgent, accessToken: "tok" };
    await ctx.route("**/api/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(mockHandler(route.request().url())),
      });
    });
  } else {
    auth = await loginApi(ctx, BASE, role);
  }
  await seedStorage(ctx, { agent: auth.agent, theme: THEME });
  return { ctx, auth };
}

async function shootCell(ctx, { route, role, sizeKey, setupErrors = [], matchingConversationLabel }) {
  const slug = slugOf(route);
  const label = `${route} / ${role} / ${sizeKey}`;
  const page = await ctx.newPage();
  const consoleErrors = [...setupErrors];
  let apiRequests = 0;
  let counting = true;
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location()?.url ? ` @ ${m.location().url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80)}` : "";
    consoleErrors.push(`${m.text().slice(0, 200)}${loc}`);
  });
  page.on("request", (r) => {
    if (counting && r.url().includes("/api/v1")) apiRequests += 1;
  });

  const problems = [];
  const frames = [];
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: "load", timeout: 45000 });
    if (LIVE_UI) {
      await page.waitForFunction(() => document.querySelector("h1") && !document.querySelector('[aria-busy="true"]'), undefined, { timeout: 20000 });
      await page.evaluate(() => document.fonts.ready);
    } else await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {
      problems.push(`${label}: сеть не успокоилась за 20 с (экран мог не дозагрузиться)`);
    });
    await sleep(700);
    counting = false;

    const finalPath = new URL(page.url()).pathname;
    if (/^\/login/.test(finalPath) && !/^\/login/.test(route)) {
      problems.push(`${label}: редирект на ${finalPath} — сессия не поднялась`);
    }

    const stat = await page.evaluate(staticMetrics);
    stat.interfaceStyles = await page.evaluate(interfaceStyleProbe);
    problems.push(...stat.interfaceStyles.issues.map((issue) => `${label}: CSS ${JSON.stringify(issue)}`));
    problems.push(...witness(stat, { label, expectTheme: EXPECT_THEME, expectWidth: SIZES[sizeKey].viewport.width }));

    const shot = async (pos) => {
      const file = `${slug}__${role}__${sizeKey}__${pos}.png`;
      await page.screenshot({ path: path.join(OUT, file) });
      frames.push(file);
    };

    let r = await page.evaluate(scrollMain, { to: "top" });
    await sleep(120);
    await shot("top");

    const steps = [];
    for (let i = 0; i < 14; i += 1) {
      steps.push(await page.evaluate(probe));
      if (r.top >= r.max) break;
      const prev = r.top;
      r = await page.evaluate(scrollMain, { by: Math.max(200, Math.round(r.client * 0.85)) });
      await sleep(120);
      if (r.top === prev) break;
    }
    r = await page.evaluate(scrollMain, { to: "bottom" });
    await sleep(350);
    await shot("bottom");
    const sheet = await probeSheet(page, slug, role, sizeKey, frames);
    problems.push(...(sheet.interfaceStyles?.issues ?? []).map((issue) => `${label}: окно CSS ${JSON.stringify(issue)}`));

    // Preserve the initial list-only mobile statistics and frames. Then test the
    // actual matching conversation as a second UI state, rather than pretending
    // that an absent mobile conversation is equivalent to the desktop thread.
    if (LIVE_UI && route.split(/[?#]/)[0] === "/messages" && sizeKey === "mobile" && needsMatchingConversationCapture(matchingConversationLabel, stat)) {
      const name = matchingConversationLabel.replace(/^Диалог:\s*/, "");
      const indexes = await page.locator(".dlg-row").evaluateAll((rows, name) => rows.flatMap((row, index) => row.querySelector(".t > b")?.textContent?.trim() === name ? [index] : []), name);
      stat.conversationComparisonCapture = { matchedRows: indexes.length, opened: false };
      if (indexes.length === 1) {
        await page.locator(".dlg-row").nth(indexes[0]).click();
        await page.waitForFunction((label) => {
          const pane = document.querySelector(".clean-conversation");
          return pane?.getAttribute("aria-label") === label && (pane.querySelector('.thread[aria-label="Переписка"]')?.innerText || "").trim().length > 0;
        }, matchingConversationLabel, { timeout: 15000 });
        const conversationMetrics = await page.evaluate(staticMetrics);
        stat.comparedConversationText = conversationMetrics.conversationText;
        stat.conversationComparisonCapture.opened = true;
        stat.conversationComparisonCapture.textLen = conversationMetrics.textLen;
        await shot("conversation");
        let conversationScroll = await page.evaluate(scrollMain, { to: "top" });
        let conversationProbeSteps = 0;
        for (let index = 0; index < 14; index += 1) {
          await sleep(120);
          steps.push(await page.evaluate(probe));
          conversationProbeSteps += 1;
          if (conversationScroll.top >= conversationScroll.max) break;
          const previousTop = conversationScroll.top;
          conversationScroll = await page.evaluate(scrollMain, { by: Math.max(200, Math.round(conversationScroll.client * 0.85)) });
          if (conversationScroll.top === previousTop) break;
        }
        stat.conversationComparisonCapture.probeSteps = conversationProbeSteps;
        await shot("conversation-bottom");
      }
    }

    const merged = mergeProbes(steps);

    return {
      ok: true,
      url: finalPath,
      ...stat,
      ...merged,
      sheet,
      consoleErrors,
      requestCount: apiRequests,
      scroll: { kind: r.kind, max: r.max, viewport: r.client, probeSteps: steps.length },
      frames,
      problems,
    };
  } catch (e) {
    problems.push(`${label}: падение прогона — ${String(e.message ?? e).split("\n")[0].slice(0, 200)}`);
    return { ok: false, consoleErrors, requestCount: apiRequests, frames, problems };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ───────────────────────────── главный прогон ───────────────────────────── */

async function main() {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log(`стенд: ${BASE}${MOCK ? " (фикстуры, без API)" : ""}; роли: ${ROLES.join(", ")}; кадры: ${OUT}`);

  const browser = await chromium.launch();
  const rows = [];
  try {
    for (const role of ROLES) {
      const opened = {};
      try {
      for (const sizeKey of SIZES_ARG) opened[sizeKey] = await openContext(browser, role, sizeKey);

      // id первой записи для параметрических маршрутов — токеном этой же роли.
      const first = opened[SIZES_ARG[0]];
      const fetchJson = async (apiPath) => {
        if (MOCK) return mockBody(`/api/v1${apiPath}`);
        const res = await first.ctx.request.get(`${BASE}/api/v1${apiPath}`, {
          headers: { Authorization: `Bearer ${first.auth.accessToken}` },
          timeout: 15000,
        });
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        return res.json();
      };

      for (const raw of routeList) {
        const resolved = await resolveParams(raw, fetchJson);
        if (resolved.skip) {
          skipped.push({ route: raw, role, reason: resolved.skip });
          console.log(`пропуск ${raw} (${role}): ${resolved.skip}`);
          continue;
        }
        const route = resolved.route;
        const row = { route, role, desktop: null, mobile: null, ratioMobileToDesktop: null, problems: [] };
        for (const sizeKey of [...SIZES_ARG].sort((a, b) => a === "desktop" ? -1 : b === "desktop" ? 1 : 0)) {
          const m = await shootCell(opened[sizeKey].ctx, { route, role, sizeKey, setupErrors: opened[sizeKey].errors, matchingConversationLabel: row.desktop?.conversationText?.label });
          row[sizeKey] = m;
          row.problems.push(...m.problems);
        }
        if (row.desktop?.ok && row.mobile?.ok && row.desktop.textLen > 0) {
          row.ratioMobileToDesktop = Math.round((row.mobile.textLen / row.desktop.textLen) * 100) / 100;
        }
        row.textComparison = compareResponsiveText(route, row.desktop, row.mobile);
        writeFileSync(path.join(OUT, `${slugOf(route)}__${role}__metrics.json`), JSON.stringify(row, null, 2));
        const s = (m) => (!m ? "не проверялось" : m.ok ? `текст ${m.textLen}, тап<44 ${m.tapTargetsBelow44}, шрифт<13 ${m.fontsBelow13}, наезд ${m.overlapCount}, обрезка ${m.clippedTextCount}, вылет ${m.outOfBoundsCount}, ош ${m.consoleErrors.length}` : "СБОЙ");
        console.log(`${route} (${role}): ПК ${s(row.desktop)} | тел ${s(row.mobile)} | доля страницы ${row.ratioMobileToDesktop ?? "—"}${row.textComparison.scope === "same-conversation-body" ? ` | тот же диалог ${row.textComparison.ratio}` : ""}`);
        rows.push(row);
      }
      } finally {
        // Restore the first context last: later contexts see the audit theme.
        for (const { ctx, restore } of Object.values(opened).reverse()) {
          try { if (restore) await restore(); } finally { await ctx.close(); }
        }
      }
    }
  } finally {
    await browser.close();
  }

  /* ── сравнение с прошлым прогоном ── */
  const baselineArg = opt("baseline");
  const baselineDir = baselineArg
    ? path.isAbsolute(baselineArg)
      ? baselineArg
      : path.resolve(repoRoot, baselineArg)
    : previousRun(parityRoot, OUT);
  let baselineRows = new Map();
  if (baselineDir && existsSync(path.join(baselineDir, "summary.json"))) {
    const prev = JSON.parse(readFileSync(path.join(baselineDir, "summary.json"), "utf8"));
    baselineRows = new Map(prev.rows.map((r) => [`${r.route}|${r.role}`, r]));
  } else if (baselineArg) {
    console.log(`ВНИМАНИЕ: в ${baselineArg} нет summary.json, сравнивать не с чем`);
  }
  for (const row of rows) {
    let delta = null;
    if (baselineDir) {
      for (const sizeKey of SIZES_ARG) {
        for (const f of row[sizeKey]?.frames ?? []) {
          const d = diffPercent(path.join(OUT, f), path.join(baselineDir, f), THRESHOLD);
          if (d !== null) delta = Math.max(delta ?? 0, d);
        }
      }
    }
    row.deltaFramePct = delta;
    const prevRow = baselineRows.get(`${row.route}|${row.role}`);
    row.metricDeltas = prevRow ? metricDeltas(prevRow, row) : null;
  }

  const summary = {
    date: new Date().toISOString(),
    base: BASE,
    mock: MOCK,
    liveUi: LIVE_UI,
    theme: THEME,
    roles: ROLES,
    baseline: baselineDir ? path.relative(repoRoot, baselineDir).replace(/\\/g, "/") : null,
    pixelThreshold: THRESHOLD,
    rows: rows.map(slim),
    skipped,
    unmockedApiPaths: MOCK ? [...unmocked].sort() : undefined,
  };
  writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(OUT, "report.md"), renderReport(summary, rows));

  /* ── код возврата ── */
  const bad = rows.filter(
    (r) =>
      r.problems.length ||
      [r.desktop, r.mobile].some((m) => m?.consoleErrors?.length) ||
      hasResponsiveTextLoss(r)
  );
  console.log(`\nэкранов: ${rows.length}, пропущено: ${skipped.filter((s) => s.role !== "*").length}, проблемных: ${bad.length}, время: ${Math.round((Date.now() - t0) / 1000)} с`);
  console.log(`отчёт: ${path.join(OUT, "report.md")}`);
  if (bad.length && !NO_FAIL) process.exitCode = 1;
}

/* ───────────────────────────── отчёт ───────────────────────────── */

const NUMERIC = ["textLen", "tapTargetsBelow44", "fontsBelow13", "overlapCount", "clippedTextCount", "outOfBoundsCount", "backdropFilterLayers", "fixedHeaders", "requestCount", "domNodes"];

function slim(row) {
  const cut = (m) =>
    m && {
      ok: m.ok,
      ...Object.fromEntries(NUMERIC.map((k) => [k, m[k]])),
      overflowX: m.overflowX,
      lowContrastCount: m.lowContrastCount,
      overlapCount: m.overlapCount,
      clippedTextCount: m.clippedTextCount,
      outOfBoundsCount: m.outOfBoundsCount,
      sheet: m.sheet?.opened
        ? { trigger: m.sheet.trigger, overlapCount: m.sheet.overlapCount, clippedTextCount: m.sheet.clippedTextCount, outOfBoundsCount: m.sheet.outOfBoundsCount }
        : null,
      consoleErrors: m.consoleErrors,
    };
  return {
    route: row.route,
    role: row.role,
    ratioMobileToDesktop: row.ratioMobileToDesktop,
    textComparison: row.textComparison,
    deltaFramePct: row.deltaFramePct,
    problems: row.problems,
    desktop: cut(row.desktop),
    mobile: cut(row.mobile),
    metricDeltas: row.metricDeltas,
  };
}

function metricDeltas(prev, row) {
  const out = [];
  const cmp = (name, a, b) => {
    if (typeof a === "number" && typeof b === "number" && a !== b) out.push(`${name} ${a}→${b}`);
  };
  cmp("доля текста", prev.ratioMobileToDesktop, row.ratioMobileToDesktop);
  for (const sizeKey of SIZES_ARG) {
    const a = prev[sizeKey];
    const b = row[sizeKey];
    if (!a || !b) continue;
    const tag = sizeKey === "desktop" ? "ПК" : "тел";
    for (const k of ["tapTargetsBelow44", "fontsBelow13", "overlapCount", "clippedTextCount", "outOfBoundsCount", "backdropFilterLayers", "fixedHeaders", "requestCount"]) cmp(`${tag}.${k}`, a[k], b[k]);
    if (typeof a.domNodes === "number" && typeof b.domNodes === "number" && Math.abs(b.domNodes - a.domNodes) > Math.max(50, a.domNodes * 0.1)) {
      cmp(`${tag}.domNodes`, a.domNodes, b.domNodes);
    }
  }
  return out;
}

function renderReport(summary, rows) {
  const L = [];
  L.push(`# Сверка редизайна, ${summary.date.slice(0, 10)}`);
  L.push("");
  L.push(
    `Стенд \`${summary.base}\`${summary.mock ? " (фикстуры)" : ""}, тема ${summary.theme}, роли ${summary.roles.join(", ")}. ` +
      `Прошлый прогон: ${summary.baseline ? `\`${summary.baseline}\`` : "нет (Δ кадра не считается)"}. Порог пикселя ${summary.pixelThreshold}/255.`
  );
  L.push("");
  const pair = (a, b) => `${a ?? "—"}/${b ?? "—"}`;
  const ok = (m) => (m?.ok ? m : null);
  const sorted = [...rows].sort((a, b) => {
    const ra = a.ratioMobileToDesktop ?? 99;
    const rb = b.ratioMobileToDesktop ?? 99;
    if (ra !== rb) return ra - rb;
    return (b.deltaFramePct ?? -1) - (a.deltaFramePct ?? -1);
  });
  L.push("Пары в ячейках: ПК/телефон. Сортировка: доля текста по возрастанию, затем Δ кадра по убыванию.");
  L.push("");
  L.push("| экран | роль | доля текста тел/ПК | тап<44 | шрифт<13 | наезд | обрезка | вылет | шторка (н/о/в) | стекло | ошибки | Δ кадра % |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const sh = (m) => (m?.sheet ? `${m.sheet.overlapCount}/${m.sheet.clippedTextCount}/${m.sheet.outOfBoundsCount}` : "—");
  for (const r of sorted) {
    const d = ok(r.desktop);
    const m = ok(r.mobile);
    const errs = pair(r.desktop?.consoleErrors?.length, r.mobile?.consoleErrors?.length);
    const flagRatio = hasResponsiveTextLoss(r) ? " ⚠" : "";
    const flagErr = errs !== "0/0" && errs !== "—/—" ? " ⚠" : "";
    const sick = r.problems.length ? " ⚠" : "";
    L.push(
      `| \`${r.route}\`${sick} | ${r.role} | ${r.ratioMobileToDesktop ?? "—"}${flagRatio} | ${pair(d?.tapTargetsBelow44, m?.tapTargetsBelow44)} | ` +
        `${pair(d?.fontsBelow13, m?.fontsBelow13)} | ${pair(d?.overlapCount, m?.overlapCount)} | ${pair(d?.clippedTextCount, m?.clippedTextCount)} | ${pair(d?.outOfBoundsCount, m?.outOfBoundsCount)} | ` +
        `${sh(d)} ${sh(m)} | ${pair(d?.backdropFilterLayers, m?.backdropFilterLayers)} | ${errs}${flagErr} | ${r.deltaFramePct ?? "—"} |`
    );
  }
  L.push("");

  for (const r of rows.filter((row) => row.textComparison?.scope === "same-conversation-body")) {
    const comparison = r.textComparison;
    L.push(`- \`${r.route}\` (${r.role}): проверка текста внутри того же диалога «${comparison.conversationLabel.replace(/[\r\n]/g, " ")}»: ${comparison.mobileTextLen}/${comparison.desktopTextLen}, доля ${comparison.ratio}. Полная доля страницы сохранена: ${comparison.rawRatio}; мобильная кнопка возврата к списку видима.`);
  }
  L.push("");

  const withProblems = rows.filter((r) => r.problems.length);
  if (withProblems.length) {
    L.push("## Замечания свидетеля и сбои");
    L.push("");
    for (const r of withProblems) for (const p of r.problems) L.push(`- ${p}`);
    L.push("");
  }
  const withErrors = rows.filter((r) => [r.desktop, r.mobile].some((m) => m?.consoleErrors?.length));
  if (withErrors.length) {
    L.push("## Ошибки консоли (первые 3 на ячейку)");
    L.push("");
    for (const r of withErrors) {
      for (const sizeKey of SIZES_ARG) {
        const errs = r[sizeKey]?.consoleErrors ?? [];
        for (const e of errs.slice(0, 3)) L.push(`- \`${r.route}\` ${r.role} ${sizeKey === "desktop" ? "ПК" : "тел"}: ${e}`);
      }
    }
    L.push("");
  }
  const mobileTouchy = rows.filter((r) => (r.mobile?.backdropFilterLayers ?? 0) > 1 || (r.mobile?.fixedHeaders ?? 0) > 1);
  if (mobileTouchy.length) {
    L.push("## Телефон: больше одного стеклянного слоя или двух шапок разом");
    L.push("");
    for (const r of mobileTouchy) {
      L.push(`- \`${r.route}\` ${r.role}: стекло ${r.mobile.backdropFilterLayers}, шапок ${r.mobile.fixedHeaders}`);
    }
    L.push("");
  }
  const deltas = rows.filter((r) => r.metricDeltas?.length);
  if (deltas.length) {
    L.push("## Изменения метрик относительно прошлого прогона");
    L.push("");
    for (const r of deltas) L.push(`- \`${r.route}\` ${r.role}: ${r.metricDeltas.join("; ")}`);
    L.push("");
  }
  L.push("## Пропущенные маршруты");
  L.push("");
  if (!summary.skipped.length) L.push("Нет.");
  for (const s of summary.skipped) L.push(`- \`${s.route}\`${s.role === "*" ? "" : ` (${s.role})`}: ${s.reason}`);
  L.push("");
  if (summary.unmockedApiPaths?.length) {
    L.push("## Пути API без фикстуры (режим --mock, экран мог быть пустым)");
    L.push("");
    for (const u of summary.unmockedApiPaths) L.push(`- \`${u}\``);
    L.push("");
  }
  return L.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

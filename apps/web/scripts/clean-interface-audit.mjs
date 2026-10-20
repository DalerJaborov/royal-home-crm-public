/** Sequential isolated-seed audit; no production targets or business writes.
 * Default: inventory only (does not import/start a browser).
 * AUDIT_ISOLATED_SEED=1 AUDIT_BASE=http://127.0.0.1:5305 node
 * apps/web/scripts/clean-interface-audit.mjs --run --role director --theme light --size mobile --out <absolute-dir>
 * Run each role/theme/size separately to keep memory bounded. A passing scan
 * does not certify dialogs absent from seed data or physical PWA behavior. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interfaceStyleProbe } from "./lib/interface-style-probe.mjs";
import { resolveParams, slugOf, staticMetrics, probe, mergeProbes, scrollMain, SEED_PASSWORD } from "./lib/parity-core.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index < 0 ? fallback : args[index + 1];
};
const out = path.resolve(option("out", path.join(repo, ".scratch-clean/interface-audit")));
mkdirSync(out, { recursive: true });
const map = JSON.parse(readFileSync(path.join(repo, "docs/product-map.json"), "utf8"));
const routes = map.screens.filter((screen) => screen.file && !screen.redirect
  && !/^\/(login|public|dev)(\/|$)/.test(screen.path));
const extra = [
  ...["expenses", "recurring", "calendar", "table", "overview", "payouts"].map((tab) => `/finance?workspace=${tab}`),
  ...["agency", "money", "leads", "matching", "team", "channels", "bot", "system"].map((tab) => `/settings?tab=${tab}`),
];
const pending = routes.map((screen) => {
  const source = readFileSync(path.join(repo, screen.file), "utf8");
  return { route: screen.path, source: screen.file, gate: screen.nav?.gate ?? null,
    status: "pending-browser", sourceHasDialog: /role=["']dialog|Modal|Dialog|Sheet/.test(source),
    sourceHasTabs: /Tabs|role=["']tab|tablist/.test(source),
    // Review pointers, NOT an automatic verdict that an unmarked page is old.
    explicitCleanSelection: /useCleanShell|CleanScreen|CleanPage|CleanRecord|CleanCatalog/.test(source),
    referenceSurface: /Rh2Screen|rh2 screens/.test(source),
    mobileBranchReview: source.split("\n").flatMap((line, index) =>
      /\bif\s*\([^)]*\bmobile\b/.test(line) ? [{ line: index + 1, condition: line.trim().slice(0, 180) }] : []),
  };
});
writeFileSync(path.join(out, "inventory.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), note: "Source inventory is NOT evidence of a passing browser check.",
  routes: pending, explicitTabs: extra.map((route) => ({ route, status: "pending-browser" })),
}, null, 2));
if (!args.includes("--run")) {
  console.log(`Inventory only: ${routes.length} routes + ${extra.length} explicit tab states; all pending.`);
} else {
  const { chromium } = await import("@playwright/test");
  const { assertLiveTarget, loginLive } = await import("./lib/parity-live-session.mjs");
  const base = process.env.AUDIT_BASE || "http://127.0.0.1:5305";
  assertLiveTarget(base);
  const role = option("role", "director");
  const elevateSeed = args.includes("--elevate-seed");
  const theme = option("theme", "light");
  const size = option("size", "desktop");
  if (!["desktop", "mobile"].includes(size) || !["light", "night"].includes(theme)) throw new Error("Invalid size/theme");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: size === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: size === "mobile", hasTouch: size === "mobile", serviceWorkers: "block", reducedMotion: "reduce",
  });
  const results = [];
    const visitedSharedPopups = new Set();
  let session;
  let page;
  try {
    session = await loginLive(context, base, role, theme);
    // Own seed preferences only: retain a recovery snapshot before route/filter
    // writes. No access token, cookies or authentication state is persisted.
    writeFileSync(path.join(out, "seed-preferences-before.json"), JSON.stringify(session.originalPreferences, null, 2));
    const actualRole = session.auth.agent.role;
    const expectedShell = actualRole === "AGENT" && size === "mobile" ? "legacy" : "clean";
    const versionResponse = await context.request.get(`${base}/version.json`);
    const buildVersion = versionResponse.ok() ? await versionResponse.json() : null;
    const blocked = [];
    // Authentication is already complete. Never let an accidental control click
    // send a message, pay money, alter staff, settings, or a production record.
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // Tabs and filters persist the same actor-owned document as the theme.
      // Allow only this seed actor's preferences and restore the whole document.
      if (request.method() === "PUT" && url.pathname === "/api/v1/me/preferences") {
        session.notePreferenceWrite();
        return route.continue();
      }
      if (["GET", "HEAD", "OPTIONS"].includes(request.method())
        || /^\/api\/v1\/(auth\/refresh|events\/ticket)$/.test(url.pathname)
        || (elevateSeed && url.pathname === "/api/v1/auth/step-up")
        // The genuine theme toggle persists this QA actor's UI preferences.
        // loginLive restores its original document when the context closes.
        || url.pathname === "/api/v1/dashboard/counters/seen"
        || /\/_seen$/.test(url.pathname)) return route.continue();
      blocked.push({ method: request.method(), path: url.pathname });
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "AUDIT_READ_ONLY" }) });
    });
    page = await context.newPage();
    const errors = [];
    const harnessNotes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Network interception intentionally blocks SW in this audit. Keep its
      // known registration error as evidence, not a false application failure.
      // Real PWA registration must be verified separately with SW allowed.
      if (text.startsWith("[pwa] service worker не зарегистрирован:")
        && text.includes("reading 'waiting'") && text.includes("workbox-window")) harnessNotes.push(text);
      else errors.push(text);
    });
    const flush = () => writeFileSync(path.join(out, `${role}-${size}-${theme}.json`), JSON.stringify({
      role, actualRole, expectedShell, size, theme, buildVersion, source: "isolated-seed", results, blockedWrites: blocked, harnessNotes, serviceWorkerBlocked: true,
      setupErrors: session.errors,
      limitations: ["Dialogs without an explicit safe trigger remain pending", "Physical PWA not tested", "Screenshots require human visual review"],
    }, null, 2));
    const capture = async (route, state) => {
      const gate = page.getByRole("heading", { name: "Подтвердите, что это вы", exact: true });
      // Let the routed React tree commit before testing its loading boundary.
      // An empty main before the first lazy render is not a ready screen.
      await page.locator("main").waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => document.querySelector("main")?.textContent.trim()
        && ![...document.querySelectorAll('main [aria-busy="true"],main .rh-sk,main .sk,main .animate-pulse')]
        .some((node) => node.checkVisibility()), undefined, { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // The StepUpGate can mount after the route's initial loading boundary.
      // Authenticate the settled initial page, never click through an open popup.
      const popupOpen = await page.locator('[role="dialog"]:visible,[role="menu"]:visible,[role="listbox"]:visible').count();
      if (elevateSeed && !popupOpen && await gate.isVisible()) {
        await page.getByLabel("Пароль", { exact: true }).fill(SEED_PASSWORD);
        await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
        await gate.waitFor({ state: "hidden", timeout: 15000 });
        await page.waitForFunction(() => ![...document.querySelectorAll('main [aria-busy="true"],main .rh-sk,main .sk,main .animate-pulse')]
          .some((node) => node.checkVisibility()), undefined, { timeout: 15000 });
      }
      const styles = await page.evaluate(interfaceStyleProbe);
      const viewport = await page.evaluate(() => ({ layoutWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
        visualWidth: visualViewport?.width ?? innerWidth, visualScale: visualViewport?.scale ?? 1 }));
      const expectedWidth = page.viewportSize().width;
      if (viewport.layoutWidth > expectedWidth + 1 || viewport.documentWidth > expectedWidth + 1) {
        styles.issues.push({ type: "expanded-layout-viewport", expectedWidth, ...viewport });
      }
      const header = await page.locator('[data-topbar-title]').evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return { text: node.textContent, x: rect.x, width: rect.width, scrollWidth: node.scrollWidth, overflow: style.overflow, scrollX: window.scrollX };
      }));
      if (styles.shell !== expectedShell) styles.issues.push({ type: "unexpected-shell", expected: expectedShell, actual: styles.shell });
      const metrics = await page.evaluate(staticMetrics);
      const steps = [];
      let scroll = await page.evaluate(scrollMain, { to: "top" });
      for (let index = 0; index < 20; index += 1) {
        steps.push(await page.evaluate(probe));
        if (scroll.top >= scroll.max) break;
        const previous = scroll.top;
        scroll = await page.evaluate(scrollMain, { by: Math.max(200, scroll.client * 0.8) });
        if (previous === scroll.top) break;
      }
      const prefix = `${role}-${size}-${theme}-${slugOf(route)}-${slugOf(state)}`;
      const bottom = scroll.max > scroll.client ? `${prefix}-bottom.png` : null;
      if (bottom) await page.screenshot({ path: path.join(out, bottom) });
      await page.evaluate(scrollMain, { to: "top" });
      const file = `${prefix}.png`;
      await page.screenshot({ path: path.join(out, file), fullPage: true });
      const dialogs = await page.locator('[role="dialog"]:visible').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") || node.textContent.slice(0, 100)));
      const windowCandidates = await page.locator('button[aria-haspopup],button[data-opens-sheet],summary').evaluateAll((nodes) => nodes
        .filter((node) => node.getBoundingClientRect().width > 0)
        .map((node) => ({ name: (node.getAttribute("aria-label") || node.textContent).trim().slice(0, 120),
          popup: node.getAttribute("aria-haspopup"), status: "not-exercised-by-this-capture" })));
      results.push({ route, finalUrl: new URL(page.url()).pathname + new URL(page.url()).search, state,
        status: await gate.isVisible() ? "blocked-by-step-up" : styles.issues.length || errors.length ? "issue" : "captured-needs-visual-review",
        styles, viewport, header, metrics, layout: mergeProbes(steps), dialogs, windowCandidates, errors: errors.splice(0), screenshot: file, bottomScreenshot: bottom });
      flush();
    };
    const fetchJson = async (url) => {
      const response = await context.request.get(`${base}/api/v1${url}`, { headers: { Authorization: `Bearer ${session.auth.accessToken}` } });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      return response.json();
    };
    const only = option("routes", "");
    const candidates = only ? only.split(",") : [...new Set([...routes.map((screen) => screen.path), ...extra])];
    for (const raw of candidates) {
      const resolved = raw === "/integrations/:name" ? await (async () => {
        try {
          const data = await fetchJson("/integrations");
          const name = data.channels?.[0]?.name;
          return name ? { route: `/integrations/${encodeURIComponent(name)}` }
            : { route: "/integrations/__qa_missing_snapshot__", emptySnapshot: true };
        } catch (error) { return { skip: `Integration list unavailable: ${error.message}` }; }
      })() : await resolveParams(raw, fetchJson);
      if (resolved.skip) { results.push({ route: raw, status: "not-exercised", reason: resolved.skip }); flush(); continue; }
      const route = resolved.route;
      try {
        await page.goto(`${base}${route}`, { waitUntil: "load" });
        await page.locator("main").waitFor({ timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), undefined, { timeout: 15000 });
        await capture(route, "initial");
        results[results.length - 1].routePattern = raw;
        if (resolved.emptySnapshot) results[results.length - 1].dataAvailability = "No integration snapshot in seed: real empty state only; populated states need explicit fixture coverage";
        flush();
        const readGroups = () => page.getByRole("tablist").evaluateAll((nodes) => nodes.flatMap((node, index) => {
          if (!node.getBoundingClientRect().width) return [];
          const panel = node.closest('[role="tabpanel"]');
          const controllingTab = panel?.id ? [...document.querySelectorAll('[role="tab"][aria-controls]')].find((tab) => tab.getAttribute("aria-controls") === panel.id) : null;
          return [{ index, label: node.getAttribute("aria-label"),
            parentTab: controllingTab?.id || panel?.getAttribute("aria-labelledby"),
            // Some existing nested groups have no enclosing tabpanel. Retain
            // the selected ancestor groups so their owning screen is reopened.
            ancestors: nodes.slice(0, index).flatMap((ancestor, ancestorIndex) => {
              if (!ancestor.getBoundingClientRect().width) return [];
              const tabs = [...ancestor.querySelectorAll('[role="tab"]')];
              const selected = tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
              return selected < 0 ? [] : [{ index: ancestorIndex, label: ancestor.getAttribute("aria-label"), selected }];
            }),
            tabs: [...node.querySelectorAll('[role="tab"]')].map((tab, tabIndex) => ({ index: tabIndex,
              name: (tab.getAttribute("aria-label") || tab.textContent).trim() })) }];
        }));
        const groups = await readGroups();
        const groupKey = (group) => `${group.parentTab ?? "root"}:${group.label ?? "unnamed"}:${group.index}`;
        const seenGroups = new Set(groups.map(groupKey));
        // Resolve within the owning group, not by concatenated textContent:
        // counters change, accessible names add spaces, and periods repeat.
        for (const group of groups) {
          for (const ancestor of group.ancestors) {
            const namedAncestor = ancestor.label ? page.getByRole("tablist", { name: ancestor.label, exact: true }) : null;
            const ancestorList = namedAncestor && await namedAncestor.count() === 1 ? namedAncestor : page.getByRole("tablist").nth(ancestor.index);
            const selected = ancestorList.getByRole("tab").nth(ancestor.selected);
            if (await selected.isVisible() && await selected.isEnabled()) await selected.click();
          }
          if (group.parentTab) {
            const owner = page.locator(`[id=${JSON.stringify(group.parentTab)}]`);
            if (await owner.count() === 1 && await owner.getAttribute("role") === "tab") await owner.click();
          }
          const named = group.label ? page.getByRole("tablist", { name: group.label, exact: true }) : null;
          const list = named && await named.count() === 1 ? named : page.getByRole("tablist").nth(group.index);
          for (const tab of group.tabs) {
            const target = list.getByRole("tab").nth(tab.index);
            if (!await target.isVisible() || !await target.isEnabled()) {
              results.push({ route, state: `tab:${group.label ?? group.index}:${tab.name}`, status: "not-exercised", reason: "Owning tab group changed or tab disabled" }); continue;
            }
            const previousPath = new URL(page.url()).pathname;
            await target.click();
            await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), undefined, { timeout: 15000 });
            await capture(route, `tab:${group.label ?? group.index}:${tab.name}`);
            if (new URL(page.url()).pathname !== previousPath) {
              await page.goBack({ waitUntil: "domcontentloaded" });
              await page.locator("main").waitFor({ timeout: 15000 });
              continue;
            }
            // Nested groups can mount only after opening their parent tab.
            for (const discovered of await readGroups()) {
              if (seenGroups.has(groupKey(discovered))) continue;
              seenGroups.add(groupKey(discovered));
              if (groups.length < 24) groups.push(discovered);
              else results.push({ route, state: `group:${discovered.label ?? discovered.index}`, status: "not-exercised", reason: "Bounded traversal limit; manual follow-up required" });
            }
          }
        }
        // Explicitly safe openings: no submit/save/delete/pay/publish clicks.
        const closePopup = async (popup) => {
          await page.keyboard.press("Escape");
          if (await popup.waitFor({ state: "hidden", timeout: 2000 }).then(() => true, () => false)) return true;
          const close = popup.getByRole("button", { name: /^(Закрыть|Отмена|Закрыть мастер)$/, exact: true });
          if (await close.count() === 1 && await close.isVisible()) await close.click();
          return popup.waitFor({ state: "hidden", timeout: 2000 }).then(() => true, () => false);
        };
        for (const name of ["Фильтры", "Категории и лимиты", "+ Расход", "Расход", "Новый клиент", "Добавить клиента", "Новая сделка", "Добавить подписку", "Набрать номер"]) {
          const trigger = page.getByRole("button", { name, exact: true });
          if (await trigger.count() !== 1 || !await trigger.isVisible()) continue;
          await trigger.click();
          const popup = page.getByRole("dialog").last();
          const opened = await popup.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
          if (opened) await capture(route, `dialog:${name}`);
          else results.push({ route, state: `dialog:${name}`, status: "not-exercised", reason: "No visible dialog after safe trigger" });
          if (opened && !await closePopup(popup)) {
            results.push({ route, state: `dialog:${name}`, status: "not-exercised", reason: "Dialog requires explicit close; stop generic probing" });
            break;
          }
        }
        // aria-haspopup describes an opening action, never an action inside its
        // menu. Exercise these windows without selecting send/pay/delete items.
        const popupNames = await page.locator('button[aria-haspopup="dialog"],button[aria-haspopup="menu"],button[aria-haspopup="listbox"]').evaluateAll((nodes) =>
          nodes.filter((node) => node.checkVisibility() && !node.disabled).map((node) => (node.getAttribute("aria-label") || node.textContent).trim()));
        for (const name of [...new Set(popupNames)]) {
          const shared = ["Ещё: разделы и профиль", "Поиск клиентов и объектов", "Профиль и выход"].includes(name) || name.startsWith("Быстрые действия,");
          if (shared && visitedSharedPopups.has(name)) continue;
          const trigger = page.getByRole("button", { name, exact: true });
          if (await trigger.count() !== 1 || !await trigger.isVisible()) continue;
          await trigger.click();
          // Declared popups can lazy-mount after the trigger click resolves.
          // Wait for the real panel before capturing or sending Escape.
          const popup = page.locator('[role="dialog"]:visible,[role="menu"]:visible,[role="listbox"]:visible').last();
          if (!await popup.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false)) {
            results.push({ route, state: `popup:${name}`, status: "not-exercised", reason: "Declared popup did not become visible" });
            continue;
          }
          await capture(route, `popup:${name}`);
          if (!await closePopup(popup)) {
            results.push({ route, state: `popup:${name}`, status: "not-exercised", reason: "Window requires explicit close; further triggers remain pending" });
            break;
          }
          if (shared) visitedSharedPopups.add(name);
        }
      } catch (error) {
        const file = `${role}-${size}-${theme}-${slugOf(route)}-failed.png`;
        await page.screenshot({ path: path.join(out, file) }).catch(() => undefined);
        results.push({ route, status: "failed-to-exercise", reason: error.message, screenshot: file }); flush();
      }
    }
    flush();
    console.log(`Captured ${results.length} states; inspect report/screenshots. Blocked writes: ${blocked.length}.`);
    if (results.some((result) => ["issue", "failed-to-exercise"].includes(result.status))) process.exitCode = 1;
  } finally {
    try {
      if (page) await page.close();
      if (session) {
        await session.restore();
        writeFileSync(path.join(out, "seed-preferences-restored.json"), JSON.stringify({ verified: true, at: new Date().toISOString() }));
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

import { test, expect, devices, type Page } from "@playwright/test";
import { contextForRole } from "./pages/roleAuth";

/**
 * НОВЫЙ ИНТЕРФЕЙС ДЛЯ ВСЕХ: АГЕНТ НА ТЕЛЕФОНЕ ПРОХОДИТ КАЖДЫЙ ПУНКТ МЕНЮ (21.11.2026).
 *
 * Раньше агенту на телефоне намеренно оставляли прежний интерфейс. Владелец включил
 * новый всем, без подмены ответов: здесь ничего не подменяется, решение берётся из
 * самого приложения. Агент (390 px, chromium и WebKit iPhone) открывает главную, все
 * разделы своего меню и карточки клиента и объекта, мастер объекта. На каждом экране:
 * новая оболочка (`data-shell="clean"`, `data-ui-look="royal"`), не белый экран и не
 * «Что-то пошло не так», без ошибок в консоли и без вылета по ширине.
 * Аварийный адрес `?look=legacy` возвращает прежний интерфейс на вкладке.
 */
const IGNORED_CONSOLE = [
  /Failed to load resource/i, // 4xx/5xx ресурсов проверяются самими экранами
  /Download the React DevTools/i,
  /\[vite\]/i,
  /service worker/i,
  /ERR_ABORTED/i,
];

const OUTSIDE_LAYOUT = /^\/properties\/(new|\d+\/edit)/;

type Finding = { path: string; problem: string };

async function inspect(page: Page, path: string, errors: string[], findings: Finding[]) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // Ошибки прерванных запросов ПРЕЖНЕЙ страницы (WebKit пишет их как «access control checks»)
  // приходят во время перехода — считаем только то, что случилось на этом экране.
  errors.length = 0;
  // Холодный dev-сервер на WebKit отдаёт ленивые куски медленно: ждём сам экран, а не время.
  const outside = OUTSIDE_LAYOUT.test(path);
  await page.waitForFunction((outsideLayout) => {
    const main = document.querySelector("main, #main, [role=main]") ?? document.body;
    return (outsideLayout || document.documentElement.dataset.shell === "clean")
      && !main.querySelector("[aria-busy='true']") && (main.textContent?.trim().length ?? 0) >= 20;
  }, outside, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    shell: document.documentElement.dataset.shell ?? null,
    look: document.documentElement.dataset.uiLook ?? null,
    text: (document.querySelector("main, #main, [role=main]") ?? document.body).textContent?.trim().length ?? 0,
    crash: /Что-то пошло не так|Вышла новая версия приложения/.test(document.body.innerText),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    pathname: location.pathname,
  }));
  // Мастер объекта живёт снаружи AppLayout: своей оболочки у него нет, вид — свой (useWizardRoyalLook).
  if (state.shell !== "clean" && !OUTSIDE_LAYOUT.test(path)) findings.push({ path, problem: `оболочка не новая (data-shell=${state.shell}, адрес ${state.pathname})` });
  if (state.look !== "royal") findings.push({ path, problem: `вид не новый (data-ui-look=${state.look})` });
  if (state.crash) findings.push({ path, problem: "экран ошибки" });
  if (state.text < 20) findings.push({ path, problem: `пустой экран (${state.text} знаков)` });
  if (state.overflow > 1) findings.push({ path, problem: `вылет по ширине на ${state.overflow}px` });
  const real = errors.filter((e) => !IGNORED_CONSOLE.some((re) => re.test(e)));
  if (real.length) findings.push({ path, problem: `консоль: ${real.slice(0, 3).join(" | ").slice(0, 400)}` });
}

test("агент на телефоне: новый интерфейс на каждом пункте меню, без белых экранов и ошибок", async ({ browser }, testInfo) => {
  test.skip(!["chromium", "webkit"].includes(testInfo.project.name), "телефон агента: chromium 390 и WebKit iPhone");
  test.setTimeout(420_000);
  const webkit = testInfo.project.name === "webkit";
  const context = await contextForRole(browser, "AGENT", webkit ? { ...devices["iPhone 13"] } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const findings: Finding[] = [];

  await inspect(page, "/", errors, findings);
  // Все пункты меню агента — из самого приложения: нижняя панель и «Ещё».
  for (const more of [page.getByRole("button", { name: /^Ещё/ }), page.locator("summary", { hasText: "Ещё" })]) {
    if (await more.first().isVisible().catch(() => false)) { await more.first().click().catch(() => undefined); break; }
  }
  await page.waitForTimeout(300);
  const menu = await page.evaluate(() => [...new Set([...document.querySelectorAll<HTMLAnchorElement>("a[href^='/']")]
    .map((a) => new URL(a.href).pathname)
    .filter((p) => !/^\/(logout|l\/|o\/)/.test(p) && !/\/\d+$/.test(p)))]);
  const extra = ["/clients", "/properties", "/messages", "/calls", "/calendar", "/tasks", "/profile", "/notifications", "/properties/new"];
  const paths = [...new Set([...menu, ...extra])].filter((p) => p !== "/");

  // Карточки: первый клиент и первый объект из списков.
  await page.goto("/clients", { waitUntil: "domcontentloaded" });
  const client = await page.locator("a[href^='/clients/']").first().getAttribute("href", { timeout: 20_000 }).catch(() => null);
  await page.goto("/properties", { waitUntil: "domcontentloaded" });
  const property = await page.locator("a[href^='/properties/']:not([href='/properties/new']):not([href='/properties/map'])").first().getAttribute("href", { timeout: 20_000 }).catch(() => null);
  if (client) paths.push(client); else findings.push({ path: "/clients", problem: "нет ни одной карточки клиента в списке" });
  if (property) paths.push(property); else findings.push({ path: "/properties", problem: "нет ни одной карточки объекта в списке" });

  for (const path of paths) await inspect(page, path, errors, findings);

  // Аварийный выход для себя: прежний интерфейс на этой вкладке, `?look=royal` — обратно.
  await page.goto("/?look=legacy");
  await expect(page.locator("html")).not.toHaveAttribute("data-shell", "clean");
  await page.goto("/?look=royal");
  await expect(page.locator("html")).toHaveAttribute("data-shell", "clean");

  await testInfo.attach("agent-phone-screens.json", { body: JSON.stringify({ paths, findings }, null, 2), contentType: "application/json" });
  console.log(`[${testInfo.project.name}] экранов: ${paths.length + 1}; находок: ${findings.length}\n${findings.map((f) => `  ${f.path}: ${f.problem}`).join("\n")}`);
  await context.close();
  expect(findings, findings.map((f) => `${f.path}: ${f.problem}`).join("\n")).toEqual([]);
});

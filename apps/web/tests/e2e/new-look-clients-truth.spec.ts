import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * СПИСОК КЛИЕНТОВ И ЗВОНКИ ГОВОРЯТ ТОЛЬКО ФАКТЫ (владелец 21.11.2026, кадры с телефона 390).
 *
 * «Зачем там отметки, типа позвонить, давно не связывались и так далее? Как он вообще это
 * узнал?… Таких ошибок чтобы не было вообще». Здесь экран на 390 px в новом виде:
 *  - в строке клиента нет советов («позвонить», «первый звонок», «Давно не связывались»,
 *    «Следующий шаг не назначен», «просрочено»), строка контакта — «последний контакт ДД.ММ»
 *    или «контакта ещё не было», без цвета тревоги; единственная метка — «ждёт принятия»;
 *  - в звонках нет «без разбора», «никто не перезвонил» спокойная, кнопка звонка одного вида.
 * Данные — настоящий ответ стенда, у первых строк подменены ровно проверяемые поля.
 * Кадры для владельца пишутся, если задан E2E_SHOTS_DIR.
 */
const SHOTS = process.env.E2E_SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

async function royal(page: Page) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { enabled: true, look: "royal" }, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

const today = new Date().toISOString();
const ADVICE = /давно не связывались|следующий шаг|позвонить сейчас|первый звонок|просрочено|нужно принять|\bсвязывались\s\d/i;

test("новый вид, 390: строка клиента без советов, контакт правдой и спокойно", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширина задаётся явно");
  await royal(page);
  await page.route((u) => u.pathname === "/api/v1/clients", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const items = body.items as Record<string, unknown>[];
    // Первые строки — проверяемые случаи: контакт сегодня, контакта не было, заявка не принята,
    // заметка в имени (в живых данных бывает «Акай хурсанд. Паварот айрапорт»).
    if (items[0]) Object.assign(items[0], { lastStaffContactAt: today, pendingAcceptance: false, acceptedAt: today, nextStep: { nextAction: "Позвонить", nextActionDate: "2026-10-01T08:00:00.000Z" } });
    if (items[1]) Object.assign(items[1], { lastStaffContactAt: null, pendingAcceptance: false, acceptedAt: today, status: "NEW", firstContactAt: null });
    if (items[2]) Object.assign(items[2], { pendingAcceptance: true, acceptedAt: null }, { lastStaffContactAt: undefined });
    if (items[3]) Object.assign(items[3], { displayName: "Акай хурсанд. Паварот айрапорт", displayNameParts: { name: "Акай хурсанд. Паварот айрапорт", anchor: null } });
    await route.fulfill({ response: res, json: body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/clients");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  const rows = page.locator(".ry-crow");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });

  const texts = await rows.evaluateAll((els) => els.map((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".ry-crow-acts").forEach((n) => n.remove());
    return copy.textContent ?? "";
  }));
  for (const t of texts) expect(t, t).not.toMatch(ADVICE);
  await expect(rows.nth(0).locator(".ry-crow-when")).toHaveText(/^последний контакт \d\d\.\d\d$/);
  await expect(rows.nth(1).locator(".ry-crow-when")).toHaveText("контакта ещё не было");
  await expect(rows.nth(2)).toContainText("ждёт принятия");
  await expect(rows.nth(2).locator(".ry-crow-when")).toHaveCount(0);
  // Цвет тревоги строке контакта не положен: ни метки тона, ни красного текста.
  expect(await page.locator(".ry-crow [data-tone]").count()).toBe(0);
  const lastColors = await page.locator(".ry-crow-last").evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  const hint = await page.locator(".ry-crow-req").first().evaluate((el) => getComputedStyle(el).color);
  for (const color of lastColors) expect(color).toBe(hint);
  // Имя с заметкой — обычное имя, не синее, как ссылка. Подсветка при наведении — только у
  // настоящей мыши (@media (hover: hover)): правило проверяет RoyalClients.test.tsx, потому что
  // десктопный проект Playwright сам наводит мышь и телефонное «залипшее» касание не воспроизводит.
  const nameColors = await page.locator(".ry-crow-name").evaluateAll((els) => els.slice(0, 5).map((el) => getComputedStyle(el).color));
  expect(new Set(nameColors).size).toBe(1);
  await page.mouse.move(0, 0);
  await shot(page, "after-390-clients.png");
});

test("новый вид, 390: звонки без «без разбора», «никто не перезвонил» спокойно, кнопки звонка одного вида", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширина задаётся явно");
  await royal(page);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const base = { endedAt: null, talkSeconds: 0, answeredBy: null, answeredByName: null, qualifiedAt: null, qualifiedBy: null, irrelevant: false,
    autoCreatedClient: false, missingCallback: false, missedCallbackHours: 2 };
  const incoming = [
    { ...base, id: "i1", phone: "+992900000896", startedAt: ago(4), answered: false, client: { id: "k1", shortId: 896, fullName: "Покупатель ПК-000896", kind: "BUYER" }, callbackAgent: { id: "a1", fullName: "Ноза" } },
    { ...base, id: "i2", phone: "+992777070100", startedAt: ago(5), answered: false, client: null, callbackAgent: null },
    { ...base, id: "i3", phone: "+992900000003", startedAt: ago(150), answered: true, talkSeconds: 52, client: { id: "k3", shortId: 3, fullName: "Тоҳир", kind: "BUYER" }, callbackAgent: null },
  ];
  await page.route((u) => u.pathname === "/api/v1/calls/incoming", (r) => r.fulfill({ json: { items: incoming, total: 3, periodTotal: 3, missed: 2, unqualified: 1, page: 1, pageSize: 20, days: 30 } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/calls?slice=incoming");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  const calls = page.locator(".ry-call");
  await expect(calls.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ry-call-flags", { hasText: "без разбора" })).toHaveCount(0);
  const nobody = page.locator(".ry-call-flag", { hasText: "никто не перезвонил" });
  if (await nobody.count()) await expect(nobody.first()).toHaveAttribute("data-tone", "neutral");
  // Кнопка звонка в строке — только живая: бледной неработающей трубки у незнакомого номера нет.
  expect(await page.locator(".ry-call-action span.ry-call-round, .ry-call-action span.ry-call-act").count()).toBe(0);
  await shot(page, "after-390-calls.png");
});

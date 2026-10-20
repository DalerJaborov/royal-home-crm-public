import { test, expect } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * Карточка сотрудника — один экран `/team/:id` на ПК и на телефоне
 * (задание docs/archive/employee-card-brief-20-09.md, раздел 5).
 *
 * Раньше это были ДВА разных облика (шторка `AgentOverviewModal` на ПК,
 * отдельный экран на телефоне), и они разъехались составом секций молча
 * (см. CLAUDE.md, «Oversight/MobileOversight»). Проверяем ровно то, что
 * страхует от повторения: одни и те же заголовки видны на обеих ширинах.
 *
 * Оба размера — в одном тесте на «chromium»-проекте (там директор уже вошёл),
 * а не в двух проектах: важно сравнить ОДНУ и ту же карточку на разных
 * ширинах, а не полагаться на то, что два независимых прогона случайно
 * открыли одного и того же сотрудника.
 */

const HEADINGS = ["Сейчас", "Что не так", "Переписка", "Звонки", "Лиды по этапам", "Объекты", "Клиенты", "Сделки"];

async function assertNoHorizontalScroll(page: import("@playwright/test").Page) {
  const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflowing, "страница шире экрана — есть горизонтальная прокрутка").toBe(false);
}

test("карточка сотрудника: те же разделы на ПК и на телефоне @smoke", async ({ page }, testInfo) => {
  // Один прогон на широкий и узкий размер сразу — держим это в проекте с
  // сохранённой сессией директора (chromium); второй проект (mobile) тот же
  // сценарий только задваивал бы сеть под тем же лимитом запросов на учётку.
  test.skip(testInfo.project.name !== "chromium", "оба размера проверяются одним прогоном на chromium");
  const { errors } = collectPageErrors(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/team");

  // Первая строка таблицы «Вся команда» — открываем того же сотрудника,
  // которого дальше проверяем на узкой ширине.
  const firstNameButton = page.locator("table.tbl tbody tr").first().locator("button.lk").first();
  const emptyTeam = page.getByText(/в команде пока никого нет/i);
  await expect(firstNameButton.or(emptyTeam)).toBeVisible({ timeout: 15_000 });
  if (!(await firstNameButton.isVisible())) {
    test.skip(true, "В команде нет сотрудников — карточку открыть не на ком");
  }
  await firstNameButton.click();

  await expect(page).toHaveURL(/\/team\/[^/]+$/, { timeout: 15_000 });
  const url = page.url();

  for (const heading of HEADINGS) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  await assertNoHorizontalScroll(page);

  // Телефон: та же карточка, свежая загрузка — так медиа-запрос темы
  // применяется от самого монтирования, а не только по резайзу.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);

  for (const heading of HEADINGS) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  }
  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  await assertNoHorizontalScroll(page);

  expect(errors, `ошибки на карточке сотрудника:\n${errors.join("\n")}`).toEqual([]);
});

test("ссылка ?agent= со старой главной переадресует на /team/:id @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "одна проверка редиректа достаточно на chromium");
  const { errors } = collectPageErrors(page);

  await page.goto("/team");
  const firstNameButton = page.locator("table.tbl tbody tr").first().locator("button.lk").first();
  const emptyTeam = page.getByText(/в команде пока никого нет/i);
  await expect(firstNameButton.or(emptyTeam)).toBeVisible({ timeout: 15_000 });
  if (!(await firstNameButton.isVisible())) {
    test.skip(true, "В команде нет сотрудников — редирект проверять не на ком");
  }
  await firstNameButton.click();
  await expect(page).toHaveURL(/\/team\/[^/]+$/, { timeout: 15_000 });
  const agentId = page.url().split("/team/")[1];

  await page.goto(`/team?agent=${agentId}`);
  await expect(page).toHaveURL(new RegExp(`/team/${agentId}$`), { timeout: 15_000 });
  await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
  expect(errors, `ошибки на редиректе ?agent=:\n${errors.join("\n")}`).toEqual([]);
});

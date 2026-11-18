import { test, expect, type Page } from "@playwright/test";
import { expectNoOverflowAt, LOOK_WIDTHS } from "./helpers/noOverflow";

/**
 * «НОВЫЙ ВИД», РАЗДЕЛ «КЛИЕНТЫ» — сторож вёрстки (пачка clients, 18.11.2026).
 *
 * Ответ /ui-shell подменяется, как в new-look.spec.ts: правило сервера
 * проверяют тесты API. Здесь — сам экран: список и карточка на девяти ширинах без
 * вылета (помощник helpers/noOverflow.ts видит и вылет, спрятанный прокручиваемой
 * рамкой оболочки), строка телефона в три строки, а номер карточки и источник,
 * скрытые в строке телефона, — в карточке клиента.
 */
async function withShell(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/ui-shell", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
    : route.fallback());
}

test("новый вид: список и карточка клиента без вылета за край на всех ширинах @smoke", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширины перебираются в десктопном проекте");
  await withShell(page, { enabled: true, look: "royal" });
  await page.goto("/clients");
  await expect(page.locator("html")).toHaveAttribute("data-ui-look", "royal");
  const firstRow = page.locator(".ry-crow").first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });
  for (const width of LOOK_WIDTHS) await expectNoOverflowAt(page, width, ".ry-clients-head, .clean-client-notices, .ry-crow, .ry-crow *, #clients-list");

  await page.setViewportSize({ width: 1440, height: 900 });
  await firstRow.locator("a.ry-crow-main").click();
  await expect(page.locator(".ry-ctabs [role=tab]").first()).toBeVisible({ timeout: 30_000 });
  for (const width of LOOK_WIDTHS) {
    await expectNoOverflowAt(page, width, ".clean-client-header, .clean-client-header .acts > *, .ry-cd-facts > *, .cd-actbar > *, .ry-ctabs");
  }
});

test("новый вид, телефон: строка клиента не выше трёх строк, номер и источник — в карточке", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "ширина задаётся явно");
  await withShell(page, { enabled: true, look: "royal" });
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/clients");
    const row = page.locator(".ry-crow").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const box = await row.boundingBox();
    expect(box!.height, `высота строки на ${width}px`).toBeLessThanOrEqual(104);
    // Номер карточки и источник есть в разметке строки, но на телефоне не видны.
    const code = (await row.locator(".ry-crow-id").textContent())?.split(" · ")[0]?.trim() ?? "";
    const source = (await row.locator(".ry-crow-req .ry-crow-pc-only").textContent())?.trim() ?? "";
    expect(code).toMatch(/\d/);
    await expect(row.locator(".ry-crow-id")).toBeHidden();
    await expect(row.locator(".ry-crow-req .ry-crow-pc-only")).toBeHidden();
    // …и достижимы в карточке: номер рядом с «назад», источник — фактом в шапке.
    await row.locator("a.ry-crow-main").click();
    await expect(page.locator(".ry-cd-facts")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".clean-client-detail .meta").first()).toHaveText(code);
    if (source) await expect(page.locator(".ry-cd-facts")).toContainText(source);
  }
});

test("без признака с сервера список клиентов в прежнем виде", async ({ page }) => {
  await withShell(page, { enabled: true });
  await page.goto("/clients");
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-look", /.+/);
  await expect(page.locator("[data-client-row]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ry-crow, .ry-clients-head")).toHaveCount(0);
});

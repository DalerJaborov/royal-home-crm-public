import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { overflowingButtons, stretchButtonLabels, type ButtonOverflow } from "./helpers/buttonOverflow";
import { collectPageErrors } from "./pages/crm.page";

/**
 * «Текст выходит из кнопок» (владелец, 27.11.2026): подпись кнопки, чипа, пилюли или
 * вкладки не должна выступать за её рамку на главных экранах. Кнопки растут по содержимому
 * (слой `theme-2026-button-fit.css`), подписи переносятся или усекаются многоточием.
 *
 * Ловит `helpers/buttonOverflow.ts`: содержимое шире/выше коробки либо текст/значок за
 * её прямоугольником. @smoke — 390px (телефон), основные экраны.
 *
 * BTN_SWEEP_DIR=<папка> — режим обхода: те же экраны на 1440/390/360, кадры и JSON со
 * списком находок в папку (так сняты «до/после» для PR); тест при этом не падает.
 */
const SWEEP_DIR = process.env.BTN_SWEEP_DIR;

const SCREENS: { name: string; url: string; ready?: string }[] = [
  { name: "today", url: "/" },
  { name: "clients", url: "/clients" },
  { name: "messages", url: "/messages" },
  { name: "properties", url: "/properties" },
  { name: "deals", url: "/deals" },
  { name: "finance", url: "/finance" },
  { name: "calendar", url: "/calendar" },
  { name: "team", url: "/team" },
  { name: "settings", url: "/settings" },
  { name: "reports", url: "/reports" },
];

const VIEWPORTS = SWEEP_DIR
  ? [{ w: 1440, h: 900 }, { w: 390, h: 844 }]
  : [{ w: 390, h: 844 }];

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  // ленивый экран ещё грузится: заглушка «Загружаем рабочий экран…» — не экран
  await page.waitForFunction(() => !/Загружаем рабочий экран/.test(document.body.innerText), undefined, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function openFirstCard(page: Page, list: string, hrefPrefix: string): Promise<boolean> {
  await page.goto(list);
  await settle(page);
  // идём по адресу, а не кликом: у строки списка поверх ссылки-аватара лежит ссылка-«вся строка»
  const href = await page.locator(`a[href^="${hrefPrefix}"]:not([href$="/map"]):not([href$="/new"])`).first().getAttribute("href").catch(() => null);
  if (!href) return false;
  await page.goto(href);
  await settle(page);
  return true;
}

test.describe("кнопки: подпись не выходит за рамку @smoke", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "chromium", "размеры задаём сами, хватает одного проекта");
  });

  for (const vp of VIEWPORTS) {
    test(`главные экраны на ${vp.w}px`, async ({ page }) => {
      test.setTimeout(300_000);
      const { errors } = collectPageErrors(page);
      await page.setViewportSize({ width: vp.w, height: vp.h });
      const tag = process.env.BTN_SWEEP_TAG ?? "run";
      // «long»: к подписи каждой кнопки дописан длинный хвост — проверяется КЛАСС, а не только сидовые тексты
      const report: Record<string, ButtonOverflow[]> = {};

      const shot = async (name: string) => {
        if (!SWEEP_DIR) return;
        fs.mkdirSync(SWEEP_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SWEEP_DIR, `${tag}-${name}-${vp.w}.png`), fullPage: false });
      };
      const visit = async (name: string, open: () => Promise<boolean>) => {
        if (!(await open())) return;
        report[name] = await overflowingButtons(page);
        await shot(name);
        await stretchButtonLabels(page);
        report[`${name}/long`] = await overflowingButtons(page);
        await shot(`${name}-long`);
      };

      for (const screen of SCREENS) {
        await visit(screen.name, async () => { await page.goto(screen.url); await settle(page); return true; });
      }
      await visit("client-card", () => openFirstCard(page, "/clients", "/clients/"));
      await visit("property-card", () => openFirstCard(page, "/properties", "/properties/"));

      if (SWEEP_DIR) {
        fs.writeFileSync(path.join(SWEEP_DIR, `${tag}-${vp.w}.json`), JSON.stringify(report, null, 2));
        return;
      }

      const lines = Object.entries(report).flatMap(([screen, list]) => list.map((b) => `${screen}: «${b.label}» ${b.box} — ${b.detail}`));
      expect(lines, `подпись выходит из кнопки на ${vp.w}px:\n${lines.join("\n")}`).toEqual([]);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
});

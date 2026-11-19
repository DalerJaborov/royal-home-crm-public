import { expect, test } from "@playwright/test";
import { overflowingElements, truncatedTexts } from "./helpers/noOverflow";

/**
 * Самопроверка e2e-помощника ширин (хвост ревью #285/#286, 19.11.2026): страница
 * собирается прямо в браузере (`setContent`), ни сервер, ни вход не нужны.
 * Прежний помощник снимал проверку с любого текста под многоточием — обрезанная сумма
 * проходила зелёной. Здесь та поломка воспроизведена: сумма и статус краснеют, имя
 * человека в списке (`LOOK_TRUNCATE_OK`) и текст, который влез, — нет.
 */
const PAGE = `<!doctype html><html><body style="margin:0">
  <style>
    .cut { display: block; width: 120px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .clamp { width: 120px; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; }
  </style>
  <main class="rows">
  <div class="row"><span class="cut ry-sum">Сумма сделки 1 250 000 сомони, комиссия 3%</span></div>
  <div class="row"><span class="clamp ry-status">Ждёт подписи договора у собственника квартиры</span></div>
  <div class="row"><span class="cut ry-chat-name">Зарина Рахимова-Назарова из Душанбе</span></div>
  <div class="row"><span class="cut ry-fits">Коротко</span></div>
  </main>
  <div class="cut ry-box"><button class="ry-btn" style="width:300px">Кнопка шире коробки</button></div>
</body></html>`;

test.describe("e2e-помощник ширин: многоточие", () => {
  test("обрезанный многоточием текст с данными — находка, имя в списке и влезший текст — нет", async ({ page }) => {
    await page.setContent(PAGE);
    const cut = await truncatedTexts(page, ".rows");
    expect(cut).toHaveLength(2);
    expect(cut[0]).toContain("span.cut ry-sum");
    expect(cut[1]).toContain("span.clamp ry-status");
    // свой список «можно резать» — и сумма перестаёт быть находкой
    expect(await truncatedTexts(page, ".rows", ".ry-sum, .ry-status, .ry-chat-name")).toEqual([]);
    // коробка с многоточием, из которой кнопка не влезла, — тоже обрезка
    expect((await truncatedTexts(page)).some((line) => line.includes("div.cut ry-box"))).toBe(true);
  });

  test("кнопка, обрезанная краем предка с многоточием, — вылет (прежде пропускалась)", async ({ page }) => {
    await page.setContent(PAGE);
    expect(await overflowingElements(page, ".ry-btn")).toEqual(["button.ry-btn"]);
    // у имени человека в списке многоточие задумано — его предок вылетом не считается
    expect(await overflowingElements(page, ".ry-btn", "", ".ry-box")).toEqual([]);
  });
});

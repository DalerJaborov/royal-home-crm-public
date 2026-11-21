import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * СТОРОЖ: ФОРМА-МАРШРУТ ПОСЛЕ СОХРАНЕНИЯ УХОДИТ ЗАМЕНОЙ (ревью #375, 21.11.2026).
 *
 * Мастер объекта (`/properties/new`) и форма объекта — это экраны-адреса, а не окна поверх. Переход на
 * карточку созданного объекта обычным `navigate` оставлял форму в истории: «Назад» из новой карточки открывал
 * мастер заново. Правило: из формы-маршрута любой переход по адресу — с `{ replace: true }`, закрытие — через
 * `useGoBack` (шаг назад туда, откуда пришли).
 *
 * Список ниже — все компоненты, которые рисуются на адресах форм (App.tsx: `properties/new`,
 * `properties/:id/edit`). Окна поверх экрана (ClientFormModal, NewDealSheet и т. п.) записи истории не
 * создают — переход из них на карточку обычный.
 */
const SRC = join(__dirname, "..", "..");
const ROUTE_FORMS = [
  "components/property-wizard/PropertyWizard.tsx",
  "components/PropertyFormModal.tsx",
  "pages/PropertyForm.tsx",
];
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Все вызовы `navigate(...)` с аргументами (по скобкам, а не по строке). */
function navigateCalls(code: string): string[] {
  const calls: string[] = [];
  const re = /\bnavigate\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    calls.push(code.slice(m.index, i));
  }
  return calls;
}

describe("форма-маршрут уходит заменой", () => {
  it("адреса форм в App.tsx — те, что описаны здесь", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/path="\/properties\/new"/);
    expect(app).toMatch(/path="properties\/:id\/edit"/);
  });
  for (const file of ROUTE_FORMS) {
    it(`${file}: каждый переход по адресу — с replace`, () => {
      const calls = navigateCalls(strip(readFileSync(join(SRC, file), "utf8")));
      const pushes = calls.filter((call) => !/replace:\s*true/.test(call));
      expect(pushes).toEqual([]);
    });
  }
  it("сторож ловит переход без replace (проверка самого сторожа)", () => {
    expect(navigateCalls('navigate(`/properties/${x}`); navigate("/a", { replace: true })').filter((c) => !/replace:\s*true/.test(c))).toHaveLength(1);
  });
});

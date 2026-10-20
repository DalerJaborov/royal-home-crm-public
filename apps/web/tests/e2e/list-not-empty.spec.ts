import { test, expect, type Page, type Response } from "@playwright/test";
import { CRASH_TEXT, collectPageErrors } from "./pages/crm.page";

/**
 * СЕРВЕР ОТДАЛ ДАННЫЕ — ЭКРАН ОБЯЗАН ИХ ПОКАЗАТЬ.
 *
 * Зачем это отдельно от smoke. Smoke проверяет, что раздел ОТКРЫЛСЯ: есть
 * заголовок, нет ErrorBoundary, чисто в консоли. Пустой список всё это проходит
 * с зелёным результатом — и именно так дважды за сентябрь у владельца пропадал
 * каталог объектов: сервер возвращал сто с лишним записей, экран показывал
 * «ничего не найдено», ни одна проверка не возражала. Класс поломок —
 * «фильтр съел данные»: правка на клиенте (фильтр по умолчанию, не тот ключ
 * ответа, сломанное сопоставление полей) прячет то, что сервер честно прислал.
 *
 * Как проверяется. Тест не считает строки в разметке — у разных списков она
 * своя, и крючок `data-list-row` есть не везде. Вместо этого берётся ОТВЕТ
 * СЕРВЕРА: если в нём пришла хотя бы одна запись, из первой достаётся
 * узнаваемая строка (имя клиента, заголовок объекта) и проверяется, что она
 * видна на странице. Это не зависит от вёрстки и переживает любую смену темы.
 *
 * Пустой ответ — не провал: у нового агентства данных может не быть вовсе.
 * Тест тогда пропускается явно, а не делает вид, что проверил.
 */

type ListScreen = {
  /** Адрес раздела. */
  path: string;
  /** Часть адреса запроса списка — по ней узнаём нужный ответ среди прочих. */
  api: RegExp;
  /** Человеческое имя для сообщения об ошибке. */
  title: string;
};

const SCREENS: ListScreen[] = [
  { path: "/properties", api: /\/api\/v1\/properties(\?|$)/, title: "Объекты" },
  { path: "/clients", api: /\/api\/v1\/clients(\?|$)/, title: "Клиенты" },
  { path: "/sellers", api: /\/api\/v1\/clients(\?|$)/, title: "Продавцы" },
  { path: "/deals", api: /\/api\/v1\/deals(\?|$)/, title: "Сделки" },
];

/**
 * Поля, любое из которых годится как узнаваемая подпись записи на экране.
 *
 * Ищем и на верхнем уровне, и на один вложенный объект вглубь: у сделки своего
 * названия нет вовсе, на доске она подписана именем клиента и заголовком
 * объекта (`client.fullName`, `property.title`).
 */
const PROBE_FIELDS = ["fullName", "title", "name", "address", "clientFullName"] as const;

/**
 * Достаёт из первой записи строку, которую экран обязан показать.
 *
 * Короткие и числовые значения не годятся: «3» найдётся на странице всегда и
 * проверка станет самообманом. Минимальная длина — четыре символа.
 */
function probeFrom(items: unknown[]): string | null {
  const first = items[0];
  if (!first || typeof first !== "object") return null;
  const direct = pickProbe(first as Record<string, unknown>);
  if (direct) return direct;
  for (const value of Object.values(first as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = pickProbe(value as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return null;
}

function pickProbe(row: Record<string, unknown>): string | null {
  for (const field of PROBE_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value.trim().length >= 4) return value.trim();
  }
  return null;
}

/**
 * Ждёт ответ списка и возвращает его записи.
 *
 * Ответ ловится подпиской ДО перехода: у собранной сборки запрос уходит раньше,
 * чем `waitForResponse` успевает подписаться после goto, — так первая версия
 * теста молча истекала по таймауту на исправном приложении.
 */
async function itemsOf(page: Page, screen: ListScreen): Promise<unknown[] | null> {
  const seen: unknown[][] = [];
  const onResponse = async (res: Response) => {
    if (!screen.api.test(res.url()) || !res.ok()) return;
    try {
      // Форма ответа у списков РАЗНАЯ и это не оплошность: постраничные отдают
      // `{ items, total }`, а короткие (сделки) — голый массив. Тест обязан
      // понимать обе, иначе половина разделов молча не проверяется.
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) seen.push(body);
      else if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
        seen.push((body as { items: unknown[] }).items);
      }
    } catch {
      // Не JSON — не наш ответ.
    }
  };
  page.on("response", onResponse);
  await page.goto(screen.path);
  await expect
    .poll(() => seen.length, { timeout: 20_000, message: `список ${screen.title} так и не пришёл с сервера` })
    .toBeGreaterThan(0);
  page.off("response", onResponse);
  // Первый пришедший ответ и есть список раздела: последующие — это дозагрузка
  // страниц и уточнённые фильтры, их первая запись может быть уже другой.
  return seen[0] ?? null;
}

for (const screen of SCREENS) {
  test(`${screen.title}: пришедшие с сервера записи видны на экране @smoke`, async ({ page }) => {
    const { errors } = collectPageErrors(page);

    const items = await itemsOf(page, screen);
    expect(items, `ответ списка ${screen.title} не похож на список`).not.toBeNull();

    if (!items || items.length === 0) {
      test.skip(true, `${screen.title}: сервер вернул пустой список — проверять нечего`);
      return;
    }

    const probe = probeFrom(items);
    expect(probe, `в первой записи ${screen.title} нет подходящего текстового поля`).not.toBeNull();

    await expect(
      page.getByText(probe!, { exact: false }).first(),
      `сервер вернул ${items.length} записей для «${screen.title}», но «${probe}» на экране не видно — ` +
        `это класс «фильтр съел данные», из-за которого пропадал каталог`
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(CRASH_TEXT)).toHaveCount(0);
    expect(errors, `ошибки на ${screen.path}:\n${errors.join("\n")}`).toEqual([]);
  });
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { loginByCode } from "./pages/codeLogin";

/**
 * КАРТОЧКА ПОДТВЕРЖДЕНИЯ ПОМОЩНИКА ГЛАЗАМИ (П4а, 01.11.2026).
 *
 * Живой Gemini здесь не зовётся НИКОГДА: ответ `POST /api/v1/ai/assistant`
 * подменяется своим SSE (status → token… → confirm → done), маршруты действий —
 * своими ответами. Проверяется то, чего не видят юнит-тесты без браузера: что
 * карточка встаёт в ленту, кнопки нажимаются, состояние сменяется на экране, и
 * как это выглядит на ПК (окно `.cw`) и на телефоне (шторка).
 *
 * Запуск: playwright.assistant.config.ts (кадры кладутся в
 * docs/design/assistant-p4a-2026-11-01/, если задан ASSISTANT_SHOTS=1).
 */

/**
 * Свой номер на проект: второй код на тот же номер сервер раньше минуты не шлёт
 * (и не больше нескольких в час) — повторный прогон в ту же минуту упадёт на входе,
 * а не на карточке. Номера — учётки сида стенда (0 директор, 2 агент).
 */
const phoneFor = (project: string) =>
  project === "mobile" ? (process.env.E2E_PHONE_MOBILE ?? "+992900000002") : (process.env.E2E_PHONE ?? "+992900000000");
const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/assistant-p4a-2026-11-01");
const takeShots = process.env.ASSISTANT_SHOTS === "1";

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function action(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    tool: "change_client_agent",
    status: "PENDING",
    preview: {
      title: "Передать клиента ПК-000042 другому агенту",
      was: { client: "ПК-000042", clientName: "Фарход Н.", href: "/clients/42", agent: "Сайфуллоев А.", accepted: true },
      becomes: { client: "ПК-000042", agent: "Каримова М.", accepted: true },
      risk: "Сайфуллоев перестанет видеть клиента; Каримова получит уведомление и задачу перезвонить сегодня.",
    },
    expiresAt: inMinutes(10),
    executedAt: null,
    undoneAt: null,
    undoUntil: null,
    result: null,
    ...over,
  };
}

const remake = (id: string) =>
  action(id, {
    tool: "send_to_remake",
    preview: {
      title: "Отправить ролик ОБ-000088 на перемонтаж",
      was: { Объект: "ОБ-000088 · ул. Айни 45", "Ролик вышел в": "Instagram, Telegram", "Возвратов на перемонтаж": 0 },
      becomes: { "Возвратов на перемонтаж": 1, Причина: "Плохой свет в кухне" },
      risk: "Монтажёр получит задание; ролик снимется из Instagram и Telegram до перемонтажа.",
      irreversible: true,
    },
  });

const sse = (...frames: Array<[string, unknown]>) =>
  frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

async function mockBackend(page: Page) {
  // Помощник включён в Настройках стенда не обязательно — включаем ответом, а не базой.
  await page.route("**/api/v1/settings", async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, aiAssistantEnabled: true } });
  });

  let turn = 0;
  await page.route("**/api/v1/ai/assistant", async (route: Route) => {
    expect(route.request().headers()["x-assistant-confirm"]).toBe("1");
    turn += 1;
    const first = turn === 1;
    const view = first ? action("11111111-1111-4111-8111-111111111111") : remake("22222222-2222-4222-8222-222222222222");
    const reply = first
      ? "Готово к передаче. Проверьте и подтвердите в карточке ниже."
      : "Подготовил перемонтаж. Это необратимо — подтвердите в карточке.";
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      body: sse(
        ["status", { message: "Ищу клиента…" }],
        ["status", { message: "Проверяю права…" }],
        ["token", { text: reply.slice(0, 20) }],
        ["token", { text: reply.slice(20) }],
        ["confirm", view],
        ["done", { reply }],
      ),
    });
  });

  await page.route("**/api/v1/ai/assistant/actions/*/confirm", async (route: Route) => {
    const id = route.request().url().split("/actions/")[1].split("/")[0];
    const base = id.startsWith("2222") ? remake(id) : action(id);
    const irreversible = id.startsWith("2222");
    await route.fulfill({
      json: {
        action: {
          ...base,
          status: "EXECUTED",
          executedAt: new Date().toISOString(),
          undoUntil: irreversible ? null : inMinutes(15),
        },
        replay: false,
      },
    });
  });
}

async function shot(page: Page, name: string, testInfo: { project: { name: string } }, focus?: Locator) {
  if (!takeShots) return;
  // Низ карточки (кнопки, «Сделано · Отменить») — в кадр: прокрутка ленты помощника до него.
  await focus?.evaluate((el) => el.scrollIntoView({ block: "end" }));
  // Курсор с кнопки — в кадре состояние покоя, а не наведение после нажатия.
  await page.mouse.move(0, 0);
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}-${testInfo.project.name}.png`) });
}

/** Всё — внутри окна помощника: на телефоне под шторкой живут кнопки главной с теми же подписями. */
const panel = (page: Page) => page.getByRole("dialog", { name: "ИИ-ассистент" });

async function ask(page: Page, text: string) {
  const input = panel(page).getByLabel("Вопрос ассистенту");
  await input.fill(text);
  await input.press("Enter");
}

test("карточка подтверждения: ждёт → сделано · отменить; необратимое — второе нажатие", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await mockBackend(page);
  await loginByCode(page, phoneFor(testInfo.project.name));
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await page.keyboard.press("Control+Slash");
  await expect(panel(page).getByLabel("Вопрос ассистенту")).toBeVisible({ timeout: 15_000 });

  // 1. Обычное действие уровня C: карточка ждёт решения.
  await ask(page, "Передай клиента ПК-000042 Каримовой");
  const card = page.locator('[data-assistant-confirm="pending"]').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Было", { exact: true }).or(card.getByText("Станет:").first()).first()).toBeVisible();
  await shot(page, "01-confirm-pending", testInfo, card);

  // 2. Подтвердить → «Сделано · Отменить».
  await card.getByRole("button", { name: "Подтвердить" }).click();
  const done = page.locator('[data-assistant-confirm="done"]').first();
  await expect(done).toBeVisible();
  await expect(done.getByRole("button", { name: "Отменить" })).toBeVisible();
  await expect(done.getByRole("button", { name: "Отменить" })).toBeFocused();
  await shot(page, "03-done-undo", testInfo, done);

  // 3. Необратимое: первое нажатие — «Да, безвозвратно», запроса ещё нет.
  await ask(page, "Отправь ролик ОБ-000088 на перемонтаж, плохой свет в кухне");
  const risky = page.locator("[data-assistant-confirm]").filter({ hasText: "перемонтаж" }).last();
  await expect(risky).toHaveAttribute("data-assistant-confirm", "pending", { timeout: 15_000 });
  await expect(risky.getByText("Необратимо", { exact: true })).toBeVisible();
  await risky.getByRole("button", { name: "Подтвердить" }).click();
  await expect(risky.getByRole("button", { name: "Да, безвозвратно" })).toBeVisible();
  await shot(page, "02-irreversible-arming", testInfo, risky);
});

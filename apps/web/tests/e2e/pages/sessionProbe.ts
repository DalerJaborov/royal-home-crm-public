import type { BrowserContext } from "@playwright/test";

/**
 * ЖИВА ЛИ СОХРАНЁННАЯ СЕССИЯ — ОДНА ПРОВЕРКА НА ВСЕ ВХОДЫ e2e (20.11.2026).
 *
 * Профиль сотрудника лежит в localStorage, поэтому с ЛЮБЫМ файлом состояния —
 * от чужого стенда с другими ключами, от вчерашней базы, с отозванной сессией —
 * приложение сперва рисует главную и уводит на /login только после отказа
 * `/auth/refresh`. Проверка «адрес сразу после goto» успевала раньше этого отказа
 * и считала мёртвую сессию живой: так краснел весь набор после чужого
 * `playwright/.auth/chromium.json` (auth.setup.ts) и ролевые проверки после
 * вчерашнего `role-agent.json` (roleAuth.ts) — Чат 3, 20.11.
 *
 * Решает ответ сервера на refresh. Нет ответа за `timeoutMs` (в файле нет
 * сессии, сервер молчит) — считаем мёртвой: лишний вход дешевле красного прогона.
 */
export async function sessionStillValid(
  context: BrowserContext,
  { timeoutMs = 15_000, onValid }: { timeoutMs?: number; onValid?: () => Promise<void> } = {},
): Promise<boolean> {
  const probe = await context.newPage();
  try {
    const refreshed = probe
      .waitForResponse((res) => res.url().endsWith("/auth/refresh") && res.request().method() === "POST", { timeout: timeoutMs })
      .then((res) => res.ok())
      .catch(() => false);
    await probe.goto("/");
    const valid = (await refreshed) && !/\/login/.test(probe.url());
    // Сервер только что перевыпустил refresh-cookie (та же сессия, новый срок —
    // routes/auth.ts): сохраняем её, пока страница пробы ещё открыта (onValid),
    // чтобы срок в файле сдвигался вместе с сессией.
    if (valid && onValid) await onValid();
    return valid;
  } finally {
    await probe.close();
  }
}

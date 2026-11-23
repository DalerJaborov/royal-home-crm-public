import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { request } from "@playwright/test";
import { sessionStillValid } from "./sessionProbe";

/**
 * Вход под конкретной ролью для ролевых проверок.
 *
 * Зачем отдельно от auth.setup.ts: тот логинится один раз директором и хранит
 * состояние на весь прогон — этого хватает смоуку, но не проверкам «что видит
 * маркетолог, а что монтажёр». Здесь на каждую роль своё состояние.
 *
 * Логинимся через API, а не через форму: у входа есть лимитер попыток, а ролей
 * семь — прогон по UI упирался бы в «Слишком много попыток входа». Ответ логина
 * ставит refresh-cookie, приложение при загрузке само меняет её на токен, то
 * есть контекст получается точно таким же, как после настоящего входа.
 *
 * Состояние кэшируется на диск: повторный прогон не логинится заново, и лимитер
 * не срабатывает даже при частых запусках.
 */

export const ROLE_PHONES = {
  DIRECTOR: "+992900000000",
  ADMIN: "+992900000001",
  AGENT: "+992900000002",
  MANAGER: "+992900000004",
  MARKETING: "+992900000005",
  EDITOR: "+992900000006",
  SECURITY: "+992900000007",
  SHAREHOLDER: "+992900000009",
  // РОП (главные руководителей, 20.11.2026): учётка сида +992900000010.
  HEAD_OF_SALES: "+992900000010",
} as const;

export type RoleName = keyof typeof ROLE_PHONES;

const API = process.env.E2E_API_URL ?? "http://localhost:4000";
/** Адрес приложения — тот же, что `baseURL` в playwright.config.ts. */
const WEB = process.env.E2E_BASE_URL ?? (process.env.E2E_PROD === "1" ? "http://localhost:4173" : "http://localhost:5173");

function stateFile(role: RoleName) {
  return path.join("playwright/.auth", `role-${role.toLowerCase()}.json`);
}

async function loginAndSave(role: RoleName) {
  const file = stateFile(role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const api = await request.newContext({ baseURL: API });
  // Стабильный X-Device-Id — иначе логин без него попадает на UA-эвристику и
  // на каждый прогон отъедает новый слот из MAX_DEVICES=3 (lib/sessions.ts),
  // вытесняя постоянные e2e-chromium/e2e-mobile из auth.setup.ts. Особенно
  // задевает роль DIRECTOR: её телефон (+992900000000) — тот же, что у
  // основного e2e-логина, так что без фиксированного id она конкурирует с
  // ним за тот же лимит устройств и валит весь прогон массовым 401.
  const headers = { "X-Device-Id": `e2e-role-${role.toLowerCase()}` };
  // Вход по коду: стенд запущен с LOGIN_CODE_DEV_ECHO=1 и возвращает devCode.
  let sent = await api.post("/api/v1/auth/login/code", { data: { phone: ROLE_PHONES[role] }, headers });
  // Параллельный тест той же роли мог только что попросить код: сервер не даёт второй
  // раньше минуты (LOGIN_SMS_RESEND_MS) — ждём отсчёт и пробуем снова.
  for (let i = 0; i < 2 && sent.status() === 429; i++) {
    const wait = Number(((await sent.json().catch(() => ({}))) as { resendAfterSec?: number }).resendAfterSec ?? 60);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    sent = await api.post("/api/v1/auth/login/code", { data: { phone: ROLE_PHONES[role] }, headers });
  }
  if (!sent.ok()) {
    throw new Error(`Код входа для роли ${role} не выдан: ${sent.status()} ${await sent.text()}`);
  }
  const { pendingToken, devCode } = (await sent.json()) as { pendingToken: string; devCode?: string };
  if (!devCode) throw new Error("Сервер не отдал devCode: запустите API с LOGIN_CODE_DEV_ECHO=1");
  const res = await api.post("/api/v1/auth/login/verify-code", { data: { pendingToken, code: devCode }, headers });
  if (!res.ok()) {
    throw new Error(`Вход под ролью ${role} не удался: ${res.status()} ${await res.text()}`);
  }
  // Признак сессии в localStorage — тот же, что кладёт приложение после входа
  // (store/auth.ts, ключ royal-home-auth): без него экран не пробует refresh-cookie
  // и сразу уводит на /login (20.11.2026, перенос входа главной ролей сюда).
  const { agent } = (await res.json()) as { agent: unknown };
  const state = await api.storageState();
  state.origins = [
    ...state.origins.filter((o) => o.origin !== new URL(WEB).origin),
    {
      origin: new URL(WEB).origin,
      localStorage: [
        { name: "royal-home-auth", value: JSON.stringify({ state: { agent, hasSession: true }, version: 1 }) },
        { name: "rh:greeting:skip", value: "1" },
        { name: "rh:passkey-offer-dismissed", value: "1" },
      ],
    },
  ];
  fs.writeFileSync(file, JSON.stringify(state));
  await api.dispose();
}

/** Контекст браузера, уже вошедший под нужной ролью. Закрывать вызывающему. */
export async function contextForRole(browser: Browser, role: RoleName, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const file = stateFile(role);
  if (!fs.existsSync(file)) await loginAndSave(role);
  let context = await browser.newContext({ ...options, storageState: file });

  // Состояние могло протухнуть (сменили пароль, вытеснила сессия другого
  // устройства). Проверяем делом, а не по возрасту файла: ответом /auth/refresh,
  // а не адресом сразу после загрузки (pages/sessionProbe.ts — с вчерашним
  // role-agent.json прежняя проверка пропускала мёртвую сессию, 20.11.2026).
  // Живая — сохраняем перевыпущенную refresh-cookie (та же сессия, новый срок) обратно в файл.
  const dead = !(await sessionStillValid(context, { onValid: () => context.storageState({ path: file }).then(() => undefined) }));
  if (dead) {
    await context.close();
    await loginAndSave(role);
    context = await browser.newContext({ ...options, storageState: file });
  }
  return context;
}

import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext } from "@playwright/test";
import { request } from "@playwright/test";

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
} as const;

export type RoleName = keyof typeof ROLE_PHONES;

const API = process.env.E2E_API_URL ?? "http://localhost:4000";

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
  const sent = await api.post("/api/v1/auth/login/code", { data: { phone: ROLE_PHONES[role] }, headers });
  if (!sent.ok()) {
    throw new Error(`Код входа для роли ${role} не выдан: ${sent.status()} ${await sent.text()}`);
  }
  const { pendingToken, devCode } = (await sent.json()) as { pendingToken: string; devCode?: string };
  if (!devCode) throw new Error("Сервер не отдал devCode: запустите API с LOGIN_CODE_DEV_ECHO=1");
  const res = await api.post("/api/v1/auth/login/verify-code", { data: { pendingToken, code: devCode }, headers });
  if (!res.ok()) {
    throw new Error(`Вход под ролью ${role} не удался: ${res.status()} ${await res.text()}`);
  }
  await api.storageState({ path: file });
  await api.dispose();
}

/** Контекст браузера, уже вошедший под нужной ролью. Закрывать вызывающему. */
export async function contextForRole(browser: Browser, role: RoleName): Promise<BrowserContext> {
  const file = stateFile(role);
  if (!fs.existsSync(file)) await loginAndSave(role);
  let context = await browser.newContext({ storageState: file });

  // Состояние могло протухнуть (сменили пароль, вытеснила сессия другого
  // устройства). Проверяем делом, а не по возрасту файла: открываем главную и
  // смотрим, не увело ли на вход. Увело — логинимся заново и пробуем ещё раз.
  const probe = await context.newPage();
  await probe.goto("/");
  const dead = /\/login/.test(probe.url());
  await probe.close();
  if (dead) {
    await context.close();
    await loginAndSave(role);
    context = await browser.newContext({ storageState: file });
  }
  return context;
}

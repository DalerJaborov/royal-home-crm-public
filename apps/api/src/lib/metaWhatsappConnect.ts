import type { MetaLoginKeyKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { resetAccountsCache, saveAccount } from "../messengers/accounts.js";
import { GRAPH_VERSION } from "../messengers/meta.js";
import { logAgentAudit } from "./audit.js";
import { describeError } from "./describeError.js";
import { metaGraphGet } from "./metaEternalTokens.js";
import { logSystemError } from "./systemError.js";

/**
 * НОМЕРА WHATSAPP BUSINESS ПОСЛЕ ВХОДА ЧЕРЕЗ FACEBOOK — ОДНА ДВЕРЬ (13.11.2026, пачка 2).
 *
 * Просьба владельца: «подключить страницу можно не только через мессенджер, а всё
 * прям подключить: и вотсап, и фб, и инста». Здесь всё про WhatsApp:
 *   - какие номера видит вход (readWhatsappNumbers);
 *   - чей ключ дал вход — компании или личный (loginKeyKind);
 *   - подписка аккаунта WhatsApp Business на наше приложение (subscribeWhatsappBusiness);
 *   - подключение номера (connectWhatsappNumber) — через общую дверь saveAccount:
 *     строка MessengerAccount канала WHATSAPP, externalId = phone_number_id.
 *
 * ОТВЕТ УХОДИТ С ЭТОГО НОМЕРА И ЕГО КЛЮЧОМ — новой логики отправки здесь нет и не
 * нужно: вебхук кладёт metadata.phone_number_id в accountExternalId
 * (messengers/meta.ts::parseIncoming), resolveIncomingAccount находит строку по
 * externalId, а отправка берёт ключ и номер СТРОКИ (lib/customerMetaTransport.ts::
 * bindCustomerMetaSendCredentials: waPhoneId = account.externalId). Единственное
 * место, бравшее только ключ из Настроек, — скачивание файлов клиента
 * (meta.ts::whatsAppMediaSource) — переведено на ключ аккаунта этой же пачкой.
 *
 * РЕГИСТРАЦИЮ НОМЕРА (POST /{phone}/register с PIN) CRM НЕ ДЕЛАЕТ: PIN двухшаговой
 * проверки — секрет владельца номера, и ошибка в нём блокирует номер. Если номер
 * не зарегистрирован, итог говорит это словами.
 *
 * ПО ДОКУМЕНТАЦИИ META (сверено 13.11.2026):
 *  - ФАКТ (developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts):
 *    id аккаунтов WhatsApp Business — `debug_token` → granular_scopes, scope
 *    `whatsapp_business_management`, поле target_ids; запасной путь —
 *    `/{business}/owned_whatsapp_business_accounts` и
 *    `/{business}/client_whatsapp_business_accounts`. Чужие аккаунты без
 *    расширенного доступа к whatsapp_business_management отвечают кодом 200.
 *  - ФАКТ (developers.facebook.com/docs/graph-api/reference/debug_token):
 *    «если право выдано на все объекты, target_ids не показываются» — поэтому
 *    список компаний (/me/businesses) читаем всегда, а не только при пустом debug_token.
 *  - ФАКТ (developers.facebook.com/documentation/business-messaging/whatsapp/
 *    solution-providers/manage-phone-numbers): `GET /{waba}/phone_numbers`, поля
 *    id, display_phone_number, verified_name, code_verification_status
 *    (VERIFIED | NOT_VERIFIED), platform_type (в примере CLOUD_API); номер
 *    после подключения надо зарегистрировать для Cloud API.
 *  - ОЦЕНКА: platform_type ≠ CLOUD_API (NOT_APPLICABLE, ON_PREMISE) — номер не
 *    готов к отправке через облако. Прямо в документации значения не расписаны.
 *  - ФАКТ (developers.facebook.com/docs/graph-api/webhooks/getting-started/
 *    webhooks-for-whatsapp, через поиск — страница целиком не читается):
 *    подписка — `POST /{waba}/subscribed_apps` без тела, маркером с доступом к
 *    аккаунту; GET того же адреса — список подписанных приложений.
 *  - ФАКТ (developers.facebook.com/docs/facebook-login/facebook-login-for-business):
 *    ключ компании из конфигурации входа узнаётся запросом
 *    `/me?fields=client_business_id` — у него это поле есть. Поля `type` у
 *    debug_token документация НЕ описывает, поэтому по нему не судим.
 *  - ОЦЕНКА: у личного ключа запрос client_business_id отвечает ошибкой поля
 *    (код 100) или пустым полем — считаем такой ключ личным.
 */

/** Сколько аккаунтов WhatsApp Business читать за вход: больше у одной компании не бывает. */
const MAX_WABAS = 25;
const MAX_BUSINESSES = 25;
const PHONE_FIELDS = "id,display_phone_number,verified_name,code_verification_status,platform_type,status";

export interface LoginWaNumber {
  id: string;
  phone: string | null;
  name: string | null;
  wabaId: string;
  wabaName: string | null;
  registered: boolean | null;
  verified: boolean | null;
}

type GraphGet = typeof metaGraphGet;

/** Список из ответа Graph: data[] с id. Пагинацию здесь не читаем — потолок задаёт limit. */
function rowsOf(data: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(data?.data) ? (data!.data as Array<Record<string, unknown>>) : [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Чей ключ дал вход. «business» — ключ компании (конфигурация входа с ключом
 * компании): не зависит от пароля человека. Остальное для WhatsApp — повод
 * предупредить.
 */
export async function loginKeyKind(token: string, get: GraphGet = metaGraphGet): Promise<MetaLoginKeyKind> {
  const r = await get("/me?fields=id,client_business_id", token);
  if (r.ok) return str(r.data?.client_business_id) ? "business" : "personal";
  // Ошибка поля у личного ключа — тоже ответ «личный» (ОЦЕНКА, см. шапку).
  return /\(#100\)|код 100|nonexisting field|client_business_id/i.test(r.error) ? "personal" : "unknown";
}

/** id аккаунтов WhatsApp Business из debug_token (granular_scopes.target_ids). */
async function wabaIdsFromDebugToken(token: string, app: { appId: string; appSecret: string } | null, get: GraphGet): Promise<string[]> {
  if (!app) return [];
  // Ключ приложения (app_id|app_secret) — сервер, наружу не уходит.
  const r = await get(`/debug_token?input_token=${encodeURIComponent(token)}`, `${app.appId}|${app.appSecret}`);
  if (!r.ok) return [];
  const data = (r.data?.data ?? null) as { granular_scopes?: Array<{ scope?: string; target_ids?: Array<string | number> }> } | null;
  const ids = new Set<string>();
  for (const g of data?.granular_scopes ?? []) {
    if (g.scope !== "whatsapp_business_management" && g.scope !== "whatsapp_business_messaging") continue;
    for (const t of g.target_ids ?? []) if (/^\d{5,30}$/.test(String(t))) ids.add(String(t));
  }
  return [...ids];
}

/**
 * Какие номера WhatsApp Business видит вход. Ошибки чтения не роняют выбор:
 * они собираются словами, и экран покажет их, только если номеров не нашлось.
 */
export async function readWhatsappNumbers(
  token: string,
  app: { appId: string; appSecret: string } | null,
  keyKind: MetaLoginKeyKind,
  get: GraphGet = metaGraphGet
): Promise<{ numbers: LoginWaNumber[]; errors: string[] }> {
  const errors: string[] = [];
  const wabas = new Map<string, string | null>();
  for (const id of await wabaIdsFromDebugToken(token, app, get)) wabas.set(id, null);

  // Компании, в которых у вошедшего есть доступ. У ключа компании это сама
  // компания-клиент (client_business_id), у личного — /me/businesses.
  const businesses: string[] = [];
  if (keyKind === "business") {
    const me = await get("/me?fields=client_business_id", token);
    const id = me.ok ? str(me.data?.client_business_id) : null;
    if (id) businesses.push(id);
  }
  const listed = await get(`/me/businesses?fields=id,name&limit=${MAX_BUSINESSES}`, token);
  if (listed.ok) {
    for (const b of rowsOf(listed.data)) if (str(b.id)) businesses.push(String(b.id));
  } else if (keyKind !== "business") {
    errors.push(`список компаний: ${listed.error}`);
  }

  for (const business of [...new Set(businesses)].slice(0, MAX_BUSINESSES)) {
    for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
      const r = await get(`/${business}/${edge}?fields=id,name&limit=100`, token);
      if (!r.ok) {
        errors.push(`${edge === "owned_whatsapp_business_accounts" ? "свои" : "клиентские"} аккаунты WhatsApp компании ${business}: ${r.error}`);
        continue;
      }
      for (const w of rowsOf(r.data)) {
        const id = str(w.id);
        if (id) wabas.set(id, str(w.name) ?? wabas.get(id) ?? null);
      }
    }
  }

  const numbers: LoginWaNumber[] = [];
  for (const [wabaId, wabaName] of [...wabas].slice(0, MAX_WABAS)) {
    const r = await get(`/${wabaId}/phone_numbers?fields=${PHONE_FIELDS}&limit=100`, token);
    if (!r.ok) {
      errors.push(`номера аккаунта WhatsApp ${wabaName ?? wabaId}: ${r.error}`);
      continue;
    }
    for (const p of rowsOf(r.data)) {
      const id = str(p.id);
      if (!id || !/^\d{5,30}$/.test(id) || numbers.some((n) => n.id === id)) continue;
      const platform = str(p.platform_type);
      const verification = str(p.code_verification_status);
      numbers.push({
        id,
        phone: str(p.display_phone_number),
        name: str(p.verified_name),
        wabaId,
        wabaName,
        registered: platform ? platform === "CLOUD_API" : null,
        verified: verification ? verification === "VERIFIED" : null,
      });
    }
  }
  return { numbers, errors };
}

export type WabaSubscribeResult = { ok: true } | { ok: false; error: string };

/**
 * Подписать аккаунт WhatsApp Business на наше приложение: без этого Meta не
 * шлёт в CRM входящие этого номера. Подписка — на приложение целиком (поля
 * вебхука задаются в настройках приложения), так что повтор безвреден.
 */
export async function subscribeWhatsappBusiness(wabaId: string, token: string): Promise<WabaSubscribeResult> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    let body: { success?: boolean; error?: { message?: string; code?: number } } | null = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (res.ok && body?.success !== false) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}${body?.error?.code ? ` код ${body.error.code}` : ""}: ${body?.error?.message ?? text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Основной номер из Настроек (или окружения) — тот, что отвечает без строки аккаунта. */
export async function settingsWaPhoneId(): Promise<string | undefined> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaPhoneId: true } });
  return s?.metaWaPhoneId?.trim() || process.env.META_WA_PHONE_ID || undefined;
}

export const PERSONAL_KEY_WARNING =
  "Ключ личный: перестанет работать, если сменить пароль Facebook или выйти из него. Для постоянной работы войдите через конфигурацию с ключом компании (номер конфигурации входа).";

export interface WhatsappConnectInput {
  number: LoginWaNumber;
  /** Ключ входа. В ответы и журнал не попадает. */
  token: string;
  keyKind: MetaLoginKeyKind;
  agentId: string | null;
  /** Итог подписки по аккаунту WhatsApp Business — один запрос на аккаунт за подключение. */
  subscriptions: Map<string, Promise<WabaSubscribeResult>>;
}

export type WhatsappConnectResult = { ok: true; accountId: string; created: boolean; message: string } | { ok: false; error: string };

/**
 * Подключить номер. Правила те же, что у Страницы (lib/metaPageConnect.ts):
 * второй строки того же номера не бывает; номер, который уже отвечает через
 * основные Настройки, не подключается; новая строка НЕ становится «по
 * умолчанию», пока в Настройках есть основной номер — иначе она забрала бы
 * ответы старым диалогам основного номера (resolveIncomingAccount без получателя).
 */
export async function connectWhatsappNumber(input: WhatsappConnectInput): Promise<WhatsappConnectResult> {
  const { number } = input;
  try {
    const mainPhone = await settingsWaPhoneId();
    if (mainPhone === number.id) return { ok: false, error: "Этот номер уже отвечает через основные настройки WhatsApp." };
    const existing = await prisma.messengerAccount.findFirst({
      where: { channel: "WHATSAPP", externalId: number.id },
      select: { id: true, isDefault: true, title: true },
    });
    const title = [number.name, number.phone].filter(Boolean).join(" · ") || `WhatsApp ${number.id}`;
    const accountId = await saveAccount({
      id: existing?.id,
      channel: "WHATSAPP",
      externalId: number.id,
      // Название, данное человеком в Каналах, не перетираем.
      title: existing?.title ?? title,
      token: input.token,
      isDefault: existing ? existing.isDefault : mainPhone ? false : undefined,
      ...(existing ? {} : { enabled: true }),
    });
    resetAccountsCache();
    logAgentAudit(input.agentId, "SETTINGS_UPDATE", "MessengerAccount", accountId, {
      channel: "WHATSAPP",
      phoneNumberId: number.id,
      wabaId: number.wabaId,
      connected: existing ? "token_refreshed" : "created",
      keyKind: input.keyKind,
      source: "facebook_login",
    });

    let pending = input.subscriptions.get(number.wabaId);
    if (!pending) {
      pending = subscribeWhatsappBusiness(number.wabaId, input.token);
      input.subscriptions.set(number.wabaId, pending);
    }
    const subscription = await pending;
    if (subscription.ok) {
      logAgentAudit(input.agentId, "SETTINGS_UPDATE", "WhatsappBusinessSubscription", number.wabaId, { phoneNumberId: number.id, source: "facebook_login" });
    } else {
      void logSystemError(
        "meta",
        `WhatsApp ${number.phone ?? number.id} подключён, но аккаунт WhatsApp Business ${number.wabaId} не подписан на приложение: ${subscription.error}`
      );
    }

    const parts = [existing ? "Ключ обновлён" : "Подключён"];
    if (!subscription.ok) parts.push(`но сообщения не придут: WhatsApp не подписан на CRM (${subscription.error})`);
    if (number.registered === false) {
      parts.push("номер не зарегистрирован для отправки через облако WhatsApp — зарегистрируйте его в WhatsApp Manager, иначе ответы не уйдут");
    } else if (number.verified === false) {
      parts.push("номер не подтверждён кодом — подтвердите его в WhatsApp Manager");
    }
    let message = parts.join(", ") + ".";
    if (input.keyKind !== "business") message += ` ${PERSONAL_KEY_WARNING}`;
    return { ok: true, accountId, created: !existing, message };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * ОТПРАВКА СМС — одна точка на всю CRM (23.09.2026).
 *
 * Потребители: код при входе (lib/loginSmsCode.ts), рассылка объекта
 * клиентам ссылкой (routes/properties/smsShare.ts), ссылки после звонка консультанта
 * (lib/telephony/liveVoicePropertyTools.ts). Все идут через `sendSms`, и
 * каждая попытка ложится строкой в `SmsMessage` — по журналу видно, что ушло,
 * кому и почему не дошло, а отказ провайдера ещё и попадает в журнал ошибок.
 *
 * Провайдер — Payom (payom.tj, lib/sms/payom.ts; до 24.09 был OsonSMS, так и не
 * подключённый). Токен и имя отправителя — в Настройках (раздел «СМС» во
 * вкладке «Каналы связи»), не в .env: владелец заводит их сам, без правки
 * сервера. Не подключено — `sendSms` честно отвечает «СМС не подключены», ничего
 * не тратя.
 *
 * Доставку Payom сообщает вебхуком (routes/sms.ts, `/sms/webhook/payom/:key`):
 * адрес с секретом уходит в каждом запросе, статус ложится в
 * `SmsMessage.deliveryStatus`. Без CRM_PUBLIC_URL (стенд, тесты) адрес не
 * передаётся — СМС уходят, статус просто остаётся первым.
 *
 * ТЕСТЫ И СТЕНДЫ НЕ РАССЫЛАЮТ. `SMS_DRY_RUN=1` в окружении, а под vitest всегда,
 * отправка не выходит в сеть: строка журнала пишется со статусом DRY_RUN, ответ —
 * как у удачной отправки. Тест, которому нужен ответ провайдера, подменяет
 * транспорт через `__setSmsTransportForTests`.
 */
import { prisma } from "../../db.js";
import { decryptSecretSafe } from "../../crypto.js";
import { logSystemError } from "../systemError.js";
import { crmPublicBase } from "../crmPublicUrl.js";
import { payomBalance, payomSend, type PayomCredentials, type ProviderSendResult } from "./payom.js";
import { toSmsPhone } from "./phone.js";
import { payomWebhookKey } from "./webhookKey.js";

export { toSmsPhone } from "./phone.js";

export const SMS_PROVIDERS = ["payom"] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** CALL_PROPERTIES — ссылки на квартиры, обсуждённые с консультантом в звонке
 *  (lib/telephony/liveVoicePropertyTools.ts, 24.09.2026). */
/** SHOWING_CONFIRM — подтверждение показа, который робот записал в звонке
 *  (lib/telephony/liveVoiceClientTools.ts, 09.10.2026). */
export type SmsPurpose = "LOGIN_CODE" | "PROPERTY_SHARE" | "CALL_PROPERTIES" | "SHOWING_CONFIRM" | "OWNER_REPORT" | "TEST";

export interface SmsConfig extends PayomCredentials {
  provider: SmsProvider;
}

type Transport = (config: SmsConfig, phone: string, text: string, opts: { webhookUrl: string | null }) => Promise<ProviderSendResult>;

const realTransport: Transport = (config, phone, text, opts) => payomSend(config, phone, text, opts);

/** Куда Payom шлёт статусы доставки; null — публичный адрес CRM не настроен или не https. */
export function payomWebhookUrl(): string | null {
  const base = crmPublicBase();
  if (!base || !base.startsWith("https://")) return null;
  return `${base}/api/v1/sms/webhook/payom/${payomWebhookKey()}`;
}
let testTransport: Transport | null = null;

/** Только для тестов: подменить ответ провайдера (null — вернуть холостой режим). */
export function __setSmsTransportForTests(transport: Transport | null): void {
  testTransport = transport;
}

function isDryRun(): boolean {
  if (testTransport) return false;
  return process.env.SMS_DRY_RUN === "1" || !!process.env.VITEST;
}

/** Действующие реквизиты провайдера; null — СМС не подключены (чего-то не хватает). */
export async function loadSmsConfig(): Promise<SmsConfig | null> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { smsProvider: true, smsApiToken: true, smsSender: true },
  });
  if (!s || s.smsProvider !== "payom") return null;
  const token = decryptSecretSafe(s.smsApiToken);
  if (!token || !s.smsSender) return null;
  return { provider: "payom", token, sender: s.smsSender };
}

export async function smsConfigured(): Promise<boolean> {
  return (await loadSmsConfig()) !== null;
}

export type SendSmsResult = { ok: true; id: string; parts: number | null; dryRun?: boolean; providerMessageId?: string | null; deliveryStatus?: string | null } | { ok: false; error: string; failureOutcome?: "refused" | "unknown" };

export async function sendSms(params: {
  phone: string;
  text: string;
  purpose: SmsPurpose;
  /** Что записать в журнал вместо текста (код входа в базу не кладём). */
  journalText?: string;
  agentId?: string | null;
  clientId?: string | null;
  propertyId?: string | null;
  includeReceipt?: boolean;
}): Promise<SendSmsResult> {
  const phone = toSmsPhone(params.phone);
  if (!phone) return { ok: false, error: "Номер не таджикский или записан неполностью — СМС на него не отправить", ...(params.includeReceipt ? { failureOutcome: "refused" as const } : {}) };

  const config = await loadSmsConfig();
  if (!config) return { ok: false, error: "СМС не подключены: заполните раздел «СМС» в Настройках → Каналы связи", ...(params.includeReceipt ? { failureOutcome: "refused" as const } : {}) };

  const dryRun = isDryRun();
  const result: ProviderSendResult = dryRun
    ? { ok: true, messageId: null, parts: null, deliveryStatus: null }
    : await (testTransport ?? realTransport)(config, phone, params.text, { webhookUrl: payomWebhookUrl() });

  const row = await prisma.smsMessage.create({
    data: {
      phone,
      purpose: params.purpose,
      text: params.journalText ?? params.text,
      status: !result.ok ? "FAILED" : dryRun ? "DRY_RUN" : "SENT",
      provider: config.provider,
      providerMessageId: result.ok ? result.messageId : null,
      parts: result.ok ? result.parts : null,
      deliveryStatus: result.ok ? result.deliveryStatus : null,
      error: result.ok ? null : result.error.slice(0, 1000),
      agentId: params.agentId ?? null,
      clientId: params.clientId ?? null,
      propertyId: params.propertyId ?? null,
    },
    select: { id: true },
  });

  if (!result.ok) {
    void logSystemError("sms", `СМС не отправлено (${params.purpose}): ${result.error}`);
    return { ok: false, error: result.error, ...(params.includeReceipt ? { failureOutcome: result.failureOutcome ?? "unknown" } : {}) };
  }
  return { ok: true, id: row.id, parts: result.parts, ...(params.includeReceipt ? { dryRun, providerMessageId: result.messageId, deliveryStatus: result.deliveryStatus } : {}) };
}

export async function smsBalance(): Promise<{ ok: true; balance: number; currency: string } | { ok: false; error: string }> {
  const config = await loadSmsConfig();
  if (!config) return { ok: false, error: "СМС не подключены" };
  if (isDryRun()) return { ok: true, balance: 0, currency: "TJS" };
  return payomBalance(config);
}

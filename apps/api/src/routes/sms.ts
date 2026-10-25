/**
 * СМС: настройки провайдера, проверочная отправка, баланс (23.09.2026).
 *
 * Отдельным роутером, а не полями в PATCH /settings: там 2000 строк и десятки
 * полей, а у СМС своё правило, которое проверяется только вместе с реквизитами —
 * вход по коду нельзя включить без рабочего провайдера и нельзя оставить
 * включённым, стерев ключ. Права и подтверждение личности — те же, что у
 * PATCH /settings, и точка возврата настроек снимается так же.
 *
 * Здесь же вебхук статусов доставки Payom (24.09.2026) — единственный роут без
 * входа: его зовёт сам Payom, а чужого отсекает секрет в адресе (webhookKey.ts).
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { decryptSecretSafe, encryptSecret } from "../crypto.js";
import { logAudit } from "../lib/audit.js";
import { captureSettingsSnapshot } from "../lib/settingsSnapshots.js";
import { logSystemError } from "../lib/systemError.js";
import { loadSmsConfig, sendSms, smsBalance, smsConfigured, toSmsPhone } from "../lib/sms/index.js";
import { PAYOM_NOT_DELIVERED, PAYOM_STATUSES } from "../lib/sms/payom.js";
import { isPayomWebhookKey } from "../lib/sms/webhookKey.js";
import { recordRecruitmentSmsReceipt } from "../lib/recruitmentCommunications.js";

export const smsRouter = Router();

async function presentSmsSettings() {
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  const token = decryptSecretSafe(s.smsApiToken);
  return {
    provider: s.smsProvider === "payom" ? ("payom" as const) : null,
    sender: s.smsSender,
    tokenConfigured: !!token,
    tokenMasked: token ? (token.length <= 4 ? "••••" : `••••${token.slice(-4)}`) : null,
    configured: (await loadSmsConfig()) !== null,
  };
}

/** Можно ли показывать кнопки отправки по СМС — любому вошедшему, без реквизитов. */
smsRouter.get("/status", requireAuth, async (_req, res) => {
  res.json({ configured: await smsConfigured() });
});

smsRouter.get("/settings", requireAuth, requirePermission("settings.view"), async (_req, res) => {
  res.json(await presentSmsSettings());
});

const smsSettingsSchema = z.object({
  provider: z.enum(["payom"]).nullable().optional(),
  /** Пустая строка — стереть ключ. JWT Payom — около 800 знаков. */
  apiToken: z.string().trim().max(4000).optional(),
  /** Альфа-имя отправителя ровно по правилу Payom: латиница, цифры и точка, до 11 знаков. */
  sender: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.]{0,11}$/, "Имя отправителя — латиница, цифры и точка, без пробелов, не длиннее 11 знаков (например RoyalHome)")
    .optional(),
});

smsRouter.patch("/settings", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const parsed = smsSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    const custom = parsed.error.issues.find((i) => i.message && i.code !== "invalid_type");
    return res.status(400).json({ error: custom?.message ?? "Неверные данные" });
  }
  const d = parsed.data;
  const data: Record<string, unknown> = {};
  if (d.provider !== undefined) data.smsProvider = d.provider;
  if (d.sender !== undefined) data.smsSender = d.sender || null;
  if (d.apiToken !== undefined) data.smsApiToken = d.apiToken ? encryptSecret(d.apiToken) : null;

  if (Object.keys(data).length === 0) return res.json(await presentSmsSettings());

  const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
  try {
    await captureSettingsSnapshot({
      agentId: req.agent!.id,
      agentName: actor?.fullName ?? "Неизвестно",
      reason: "update",
      nextData: data,
    });
  } catch (err) {
    void logSystemError("api", `Точка возврата перед правкой СМС не снята: ${(err as Error).message}`);
  }
  await prisma.settings.update({ where: { id: "singleton" }, data });
  // В журнал — какие поля, без значений: ключ туда не должен попасть даже маской.
  logAudit(req, "settings.sms.update", "Settings", "singleton", { fields: Object.keys(data) });
  res.json(await presentSmsSettings());
});

const testSchema = z.object({ phone: z.string().min(9).max(30) });

/** Проверочное СМС на указанный номер — ровно тот путь, по которому пойдут коды. */
smsRouter.post("/test", requireAuth, requirePermission("settings.manage"), requireElevation, async (req, res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success || !toSmsPhone(parsed.data.phone)) {
    return res.status(400).json({ error: "Укажите таджикский номер, например +992900000001" });
  }
  const sent = await sendSms({
    phone: parsed.data.phone,
    text: "Royal Home CRM: проверка СМС. Если вы это читаете, отправка работает.",
    purpose: "TEST",
    agentId: req.agent!.id,
  });
  if (!sent.ok) return res.status(502).json({ error: sent.error });
  const receipt = await prisma.smsMessage.findUnique({ where: { id: sent.id }, select: { status: true } });
  res.json({ ok: true, parts: sent.parts, status: receipt?.status ?? "UNKNOWN" });
});

smsRouter.get("/balance", requireAuth, requirePermission("settings.view"), async (_req, res) => {
  const r = await smsBalance();
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json({ balance: r.balance, currency: r.currency });
});

const payomWebhookSchema = z.object({
  id: z.string().min(1).max(100),
  status: z.enum(PAYOM_STATUSES),
  /** Unix-время события в миллисекундах. */
  timestamp: z.number().int().positive(),
});

const PURPOSE_LABELS: Record<string, string> = {
  LOGIN_CODE: "код входа",
  PROPERTY_SHARE: "объект клиенту",
  CALL_PROPERTIES: "объекты после звонка",
  SHOWING_CONFIRM: "показ по звонку",
  TEST: "проверка",
};

/**
 * Статус доставки от Payom. Отвечаем 200 и на то, что не смогли применить
 * (чужой id, устаревший статус): повторов у Payom нет, а ошибка в ответ ничего
 * не исправит. 404 — только неверный секрет, 400 — неразборчивое тело.
 */
smsRouter.post("/webhook/payom/:key", async (req, res) => {
  if (!isPayomWebhookKey(String(req.params.key))) return res.status(404).json({ error: "Not found" });
  const parsed = payomWebhookSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  const { id, status, timestamp } = parsed.data;
  const at = new Date(timestamp);
  await recordRecruitmentSmsReceipt(id, status, at);

  // Одним условным UPDATE: вебхуки приходят вразнобой и могут прийти дважды —
  // пишется только более свежий, повтор того же события ничего не меняет.
  const updated = await prisma.smsMessage.updateMany({
    where: {
      provider: "payom",
      providerMessageId: id,
      OR: [{ deliveryStatusAt: null }, { deliveryStatusAt: { lt: at } }],
    },
    data: { deliveryStatus: status, deliveryStatusAt: at },
  });

  if (updated.count > 0 && PAYOM_NOT_DELIVERED.includes(status)) {
    const row = await prisma.smsMessage.findFirst({ where: { provider: "payom", providerMessageId: id }, select: { purpose: true } });
    // Без номера и id в тексте: одинаковые отказы складываются в одну строку журнала.
    void logSystemError(
      "sms",
      `СМС не доставлено (${PURPOSE_LABELS[row?.purpose ?? ""] ?? row?.purpose ?? "?"}): Payom вернул ${status}. ` +
        "Если так со всеми — проверьте в кабинете payom.tj, одобрено ли имя отправителя и есть ли баланс."
    );
  }
  res.json({ ok: true });
});

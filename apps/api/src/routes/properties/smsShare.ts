/**
 * РАССЫЛКА ОБЪЕКТА ПО СМС (23.09.2026, просьба владельца: «клиент нажимает
 * ссылку и уходит на наш сайт на этот объект, под фото — видео Instagram»).
 *
 * POST /properties/:id/sms-share { clientIds } — одно СМС каждому клиенту со
 * ссылкой. Ссылка — личная приватная ссылка клиента (PropertyShareLink) с
 * переходом `/api/v1/l/<токен>/go` (routes/propertyShare.ts): опубликованный
 * объект открывается на сайте royalhome.tj, несайтовый — на странице ссылки CRM.
 * Через свою ссылку, а не прямым адресом сайта, потому что так в карточке
 * объекта видно «открыл/не открыл» по каждому клиенту и засчитывается интерес.
 *
 * Правила:
 *  - получатель — клиент, которого отправитель и так видит: свой или любой при
 *    праве clients.viewAll (подбор под объект — GET /:id/matching-clients —
 *    требует того же права);
 *  - несайтовый объект рассылает только тот, кто им управляет — как и приватную
 *    ссылку (shareLinks.ts);
 *  - проданный и удалённый объект не рассылается;
 *  - тому же клиенту про тот же объект — не чаще раза в 7 дней: двойное нажатие
 *    и повторная рассылка по той же подборке не должны стоить денег и терпения;
 *  - не больше 50 получателей за раз: это рассылка по подборке, не спам по базе;
 *  - не больше 100 СМС в сутки (по Душанбе) на сотрудника — каждое платное, а
 *    «разные клиенты × разные объекты» повтор-за-7-дней не останавливает
 *    (находка №150, ночная проверка 24.09.2026).
 *
 * В хронологию клиента ложится запись типа SYSTEM от имени отправителя — не
 * MESSAGE: СМС не разговор, и засчитываться в «касания» отчётов оно не должно.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { canManageProperty } from "./shared.js";
import { foreignWriteDenied } from "../clients/shared.js";
import { getOrCreatePropertyShareLinks } from "../../lib/propertyShareLink.js";
import { crmPublicBase } from "../../lib/crmPublicUrl.js";
import { recordInterest } from "../../lib/propertyInterest.js";
import { logTimeline } from "../../lib/timeline.js";
import { logSystemError } from "../../lib/systemError.js";
import { sendSms, smsConfigured, toSmsPhone } from "../../lib/sms/index.js";
import { dushanbeStartOfToday } from "../../lib/dushanbeTime.js";

export const smsShareRouter = Router();

export const SMS_SHARE_MAX_RECIPIENTS = 50;
export const SMS_SHARE_REPEAT_DAYS = 7;
/** Сколько СМС в сутки (по Душанбе) может отправить один сотрудник. */
export const SMS_SHARE_DAILY_CAP = 100;

const schema = z.object({ clientIds: z.array(z.guid()).min(1).max(SMS_SHARE_MAX_RECIPIENTS) });

function formatPrice(price: unknown, currency: string): string {
  const n = Math.round(Number(price));
  const grouped = n.toLocaleString("ru-RU").replace(/ /g, " ");
  return currency === "USD" ? `$${grouped}` : `${grouped} сом.`;
}

/** Текст короткий намеренно: кириллица — 70 знаков на часть, каждая часть платная. */
export function propertySmsText(p: {
  shortId: number;
  title: string;
  rooms: number | null;
  areaSqm: unknown;
  price: unknown;
  currency: string;
  url: string;
  agent: { fullName: string; phone: string };
}): string {
  const facts = [p.rooms ? `${p.rooms}-комн.` : null, `${Math.round(Number(p.areaSqm))} м²`, formatPrice(p.price, p.currency)]
    .filter(Boolean)
    .join(", ");
  const firstName = p.agent.fullName.split(/\s+/)[0] ?? p.agent.fullName;
  return `Royal Home, объект №${p.shortId}: ${facts}. Фото, видео и карта: ${p.url} Агент ${firstName} ${p.agent.phone}`;
}

export type SmsShareOutcome = { clientId: string; status: "sent" | "prepared" | "skipped" | "failed"; reason?: string };

smsShareRouter.post("/:id/sms-share", requireAuth, async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Выберите от 1 до ${SMS_SHARE_MAX_RECIPIENTS} клиентов` });
  }
  const propertyId = z.guid().safeParse(req.params.id);
  if (!propertyId.success) return res.status(400).json({ error: "Неверный объект" });
  const property = await prisma.property.findUnique({ where: { id: propertyId.data },
    include: { deleteRequests: { where: { requestedById: req.agent!.id, status: "PENDING" }, take: 1, select: { id: true } } } });
  if (!property || property.deletedAt || (!can(req, "properties.delete") && property.deleteRequests.length > 0)) return res.status(404).json({ error: "Объект не найден" });
  if (property.status === "SOLD" || property.status === "WITHDRAWN") return res.status(400).json({ error: "Объект продан или снят с продажи — рассылать его нельзя" });
  if (property.offSite && !canManageProperty(req, property)) {
    return res.status(403).json({ error: "Несайтовый объект рассылает только агент, который его ведёт" });
  }
  if (!(await smsConfigured())) {
    return res.status(400).json({ error: "СМС не подключены: директор включает их в Настройках → Каналы связи" });
  }
  const base = crmPublicBase();
  if (!base) return res.status(500).json({ error: "Не задан публичный адрес CRM (CRM_PUBLIC_URL) — ссылку не собрать" });

  const sender = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true, phone: true } });
  if (!sender) return res.status(401).json({ error: "Не авторизован" });

  // Потолок на сутки — по всем СМС сотрудника (любое назначение), а не только по
  // рассылке объектов: деньги тратятся одинаково. Сутки — по Душанбе.
  const usedToday = await prisma.smsMessage.count({
    where: { agentId: req.agent!.id, status: { in: ["SENT", "DRY_RUN"] }, createdAt: { gte: dushanbeStartOfToday() } },
  });
  if (usedToday >= SMS_SHARE_DAILY_CAP) {
    return res.status(429).json({
      error: `На сегодня лимит СМС исчерпан (${SMS_SHARE_DAILY_CAP} в сутки). Завтра отправка снова заработает`,
    });
  }
  const smsLeft = SMS_SHARE_DAILY_CAP - usedToday;

  const ids = [...new Set(parsed.data.clientIds)];
  const clients = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: { id: true, phone: true, deletedAt: true, assignedAgentId: true, acceptedAt: true },
  });
  const byId = new Map(clients.map((c) => [c.id, c]));
  const ownAgentId = scopeToOwnAgent(req);

  // Кому уже отправляли этот объект за последние 7 дней — одним запросом на всех.
  const since = new Date(Date.now() - SMS_SHARE_REPEAT_DAYS * 24 * 60 * 60 * 1000);
  const recent = await prisma.smsMessage.findMany({
    where: {
      propertyId: property.id,
      clientId: { in: ids },
      purpose: "PROPERTY_SHARE",
      status: { in: ["SENT", "DRY_RUN"] },
      createdAt: { gte: since },
    },
    select: { clientId: true },
  });
  const alreadySent = new Set(recent.map((r) => r.clientId));

  const outcomes: SmsShareOutcome[] = [];
  let sentNow = 0;
  for (const clientId of ids) {
    const c = byId.get(clientId);
    if (!c || c.deletedAt || !canAccessAssignedAgent(req, c.assignedAgentId) || foreignWriteDenied(req, c, ownAgentId)) {
      outcomes.push({ clientId, status: "skipped", reason: "клиент не найден или не ваш" });
      continue;
    }
    if (ownAgentId && !c.acceptedAt) {
      outcomes.push({ clientId, status: "skipped", reason: "сначала примите лид" });
      continue;
    }
    if (!toSmsPhone(c.phone)) {
      outcomes.push({ clientId, status: "skipped", reason: "номер не таджикский или неполный" });
      continue;
    }
    if (alreadySent.has(clientId)) {
      outcomes.push({ clientId, status: "skipped", reason: `уже отправляли за ${SMS_SHARE_REPEAT_DAYS} дней` });
      continue;
    }

    if (sentNow >= smsLeft) {
      outcomes.push({ clientId, status: "skipped", reason: `дневной лимит СМС (${SMS_SHARE_DAILY_CAP}) исчерпан` });
      continue;
    }

    // Ссылка у каждого клиента своя — иначе «открыл/не открыл» не различить.
    const links = await getOrCreatePropertyShareLinks(prisma, {
      propertyIds: [property.id],
      clientId,
      createdByAgentId: req.agent!.id,
    });
    const link = links.get(property.id)!;
    const url = `${base}/api/v1/l/${link.token}/go`;
    const text = propertySmsText({ ...property, url, agent: sender });

    const sent = await sendSms({
      phone: c.phone,
      text,
      purpose: "PROPERTY_SHARE",
      agentId: req.agent!.id,
      clientId,
      propertyId: property.id,
    });
    if (!sent.ok) {
      outcomes.push({ clientId, status: "failed", reason: sent.error });
      // Номер проверен выше, значит отказал сам провайдер (баланс, блокировка,
      // недоступен) — остальным не уйдёт точно так же, и слать дальше незачем.
      for (const rest of ids.slice(ids.indexOf(clientId) + 1)) {
        outcomes.push({ clientId: rest, status: "failed", reason: "рассылка остановлена после отказа провайдера" });
      }
      break;
    }
    // A dry-run is preparation, not customer outreach. The SMS journal is the
    // provider acceptance receipt; no exposure is invented for preview/copy.
    const receipt = await prisma.smsMessage.findUnique({ where: { id: sent.id }, select: { status: true, createdAt: true } });
    if (receipt?.status !== "SENT") {
      outcomes.push({ clientId, status: "prepared", reason: "тестовый режим: СМС подготовлено, клиенту не отправлено" });
      continue;
    }
    await prisma.propertyExposure.upsert({ where: { id: `sms:${sent.id}` }, create: {
      id: `sms:${sent.id}`, channel: "SMS", recipientId: clientId, clientId,
      propertyId: property.id, shortId: property.shortId, kind: "LINK", sentAt: receipt.createdAt,
    }, update: {} }).catch(err => {
      void logSystemError("sms", `Принятая СМС ${sent.id}: не записана история объекта: ${err instanceof Error ? err.message : String(err)}`);
    });
    outcomes.push({ clientId, status: "sent" });
    sentNow += 1;
    void recordInterest(property.id, "SHARE_SENT", clientId);
    await logTimeline({
      clientId,
      actor: { kind: "agent", agentId: req.agent!.id },
      type: "SYSTEM",
      propertyId: property.id,
      notes: `Отправлен по СМС объект №${property.shortId} «${property.title}»`,
    }).catch(err => {
      void logSystemError("sms", `Принятая СМС ${sent.id}: не записана хронология: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  res.json({
    sent: outcomes.filter((o) => o.status === "sent").length,
    items: outcomes,
  });
});

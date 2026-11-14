import { Router } from "express";
import { z } from "zod";
import { metaEternalAppReviewInputSchema, metaEternalPageInputSchema, metaEternalPreferredInputSchema } from "@royal-home/shared";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { prisma } from "../db.js";
import { logAudit } from "../lib/audit.js";
import { resetAccountsCache, saveAccount } from "../messengers/accounts.js";
import type { MetaCompanyPage } from "@royal-home/shared";
import {
  discoverInstagramPage,
  facebookPageForConnect,
  listCompanyPages,
  pageMessagingSubscribed,
  metaEternalStatus,
  resetMetaEternalCache,
  subscribePageMessaging,
  verifyInstagramPage,
} from "../lib/metaEternalTokens.js";

/**
 * ВЕЧНЫЕ КЛЮЧИ META — экран Настройки → Каналы (12.11.2026).
 * Самопроверка «кому что докликать», рубильник, «Найти Страницу» и
 * «Подписать Страницу». Логика — lib/metaEternalTokens.ts, здесь только вход.
 */
export const settingsMetaEternalRouter = Router();
settingsMetaEternalRouter.use(requireAuth, requirePermission("settings.manage"));

const accountParams = z.object({ id: z.string().uuid() });
const pageParams = z.object({ pageId: z.string().regex(/^\d{5,30}$/) });

settingsMetaEternalRouter.get("/", async (_req, res, next) => {
  try { res.json(await metaEternalStatus()); } catch (err) { next(err); }
});

settingsMetaEternalRouter.put("/preferred", requireElevation, async (req, res, next) => {
  const body = metaEternalPreferredInputSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Некорректное значение" });
  try {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaSystemTokenPreferred: body.data.enabled } });
    resetMetaEternalCache();
    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { metaSystemTokenPreferred: body.data.enabled });
    res.json({ ok: true, enabled: body.data.enabled });
  } catch (err) { next(err); }
});

/**
 * Отметка директора «App Review одобрен». Проверить уровень доступа приложения
 * через Graph нельзя надёжно (его отдаёт только панель разработчика), поэтому —
 * ручная галочка: без неё переписка ключом компании не включается (клиенты без
 * роли в приложении ответа не получат).
 */
settingsMetaEternalRouter.put("/app-review", requireElevation, async (req, res, next) => {
  const body = metaEternalAppReviewInputSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Некорректное значение" });
  try {
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaAppReviewApproved: body.data.approved } });
    resetMetaEternalCache();
    logAudit(req, "SETTINGS_UPDATE", "Settings", "singleton", { metaAppReviewApproved: body.data.approved });
    res.json({ ok: true, approved: body.data.approved });
  } catch (err) { next(err); }
});

/** Привязать Страницу к аккаунту Instagram: указанную или найденную. Meta подтверждает связь. */
settingsMetaEternalRouter.post("/accounts/:id/page", requireElevation, async (req, res, next) => {
  const params = accountParams.safeParse(req.params);
  const body = metaEternalPageInputSchema.safeParse(req.body ?? {});
  if (!params.success || !body.success) return res.status(400).json({ error: "Некорректные данные Страницы" });
  try {
    const account = await prisma.messengerAccount.findUnique({ where: { id: params.data.id }, select: { id: true, channel: true, externalId: true } });
    if (!account || account.channel !== "INSTAGRAM") return res.status(404).json({ error: "Аккаунт Instagram не найден" });
    let pageId = body.data.pageId;
    let pageName: string | undefined;
    if (!pageId) {
      const found = await discoverInstagramPage(account.externalId);
      if (!found.ok) return res.status(409).json({ error: found.error });
      pageId = found.pageId;
      pageName = found.pageName;
    }
    const verified = await verifyInstagramPage(pageId, account.externalId);
    if (!verified.ok) return res.status(409).json({ error: verified.error });
    await prisma.messengerAccount.update({ where: { id: account.id }, data: { pageId } });
    resetAccountsCache();
    logAudit(req, "SETTINGS_UPDATE", "MessengerAccount", account.id, { pageId });
    res.json({ ok: true, pageId, pageName: verified.pageName ?? pageName });
  } catch (err) { next(err); }
});

settingsMetaEternalRouter.delete("/accounts/:id/page", requireElevation, async (req, res, next) => {
  const params = accountParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Некорректный идентификатор аккаунта" });
  try {
    await prisma.messengerAccount.updateMany({ where: { id: params.data.id, channel: "INSTAGRAM" }, data: { pageId: null } });
    resetAccountsCache();
    logAudit(req, "SETTINGS_UPDATE", "MessengerAccount", params.data.id, { pageId: null });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Подписать Страницу на сообщения для нашего приложения. Это действие в Meta,
 * поэтому только кнопкой владельца, с подтверждением входа (requireElevation).
 */
settingsMetaEternalRouter.post("/pages/:pageId/subscribe", requireElevation, async (req, res, next) => {
  const params = pageParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Некорректный идентификатор Страницы" });
  try {
    const known = await prisma.messengerAccount.findFirst({ where: { pageId: params.data.pageId }, select: { id: true } });
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageId: true } });
    const fbAccount = await prisma.messengerAccount.findFirst({ where: { channel: "FACEBOOK", externalId: params.data.pageId }, select: { id: true } });
    // Подписываем только свои Страницы — не произвольный id из запроса.
    if (!known && !fbAccount && settings?.metaPageId !== params.data.pageId) {
      return res.status(404).json({ error: "Эта Страница не подключена в CRM" });
    }
    const result = await subscribePageMessaging(params.data.pageId);
    if (!result.ok) return res.status(409).json({ error: result.error });
    logAudit(req, "SETTINGS_UPDATE", "FacebookPageSubscription", params.data.pageId, { fields: result.fields });
    res.json(result);
  } catch (err) { next(err); }
});

/** Страницы, выданные ключу компании, и какие из них уже отвечают в CRM. Ничего не меняет. */
settingsMetaEternalRouter.get("/pages", async (_req, res, next) => {
  try {
    const listed = await listCompanyPages();
    if (!listed.ok) return res.json({ pages: [], error: listed.error });
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageId: true } });
    const accounts = await prisma.messengerAccount.findMany({ where: { channel: "FACEBOOK" }, select: { id: true, externalId: true } });
    const pages: MetaCompanyPage[] = [];
    for (const p of listed.pages) {
      const account = accounts.find((a) => a.externalId === p.id);
      const connected = account ? "account" : settings?.metaPageId === p.id ? "settings" : null;
      pages.push({
        id: p.id,
        name: p.name,
        canMessage: p.canMessage,
        connected,
        ...(account ? { accountId: account.id } : {}),
        subscribed: connected ? await pageMessagingSubscribed(p.id) : null,
      });
    }
    res.json({ pages });
  } catch (err) { next(err); }
});

/**
 * «Подключить Messenger»: Страница из списка ключа компании становится
 * аккаунтом FACEBOOK (маркер Страницы от системного пользователя) и сразу
 * подписывается на сообщения. Имя бренда и свой промт берутся у Instagram той
 * же Страницы, если он уже подключён (Arvan: бот называет компанию «Арван»).
 * Повторное нажатие обновляет маркер и подписку, вторую строку не заводит.
 */
settingsMetaEternalRouter.post("/pages/:pageId/connect", requireElevation, async (req, res, next) => {
  const params = pageParams.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Некорректный идентификатор Страницы" });
  try {
    const pageId = params.data.pageId;
    const page = await facebookPageForConnect(pageId);
    if (!page.ok) return res.status(page.status).json({ error: page.error });
    const existing = await prisma.messengerAccount.findFirst({ where: { channel: "FACEBOOK", externalId: pageId }, select: { id: true, isDefault: true } });
    const twin = page.igId
      ? await prisma.messengerAccount.findFirst({
          where: { channel: "INSTAGRAM", externalId: page.igId },
          select: { brandName: true, systemPrompt: true },
        })
      : null;
    const accountId = await saveAccount({
      id: existing?.id,
      channel: "FACEBOOK",
      externalId: pageId,
      title: page.pageName,
      token: page.token,
      // Явно: иначе единственная строка канала стала бы «по умолчанию» и забрала
      // у основной Страницы из Настроек незнакомых получателей.
      isDefault: existing?.isDefault ?? false,
      ...(existing ? {} : { enabled: true, brandName: twin?.brandName ?? undefined, systemPrompt: twin?.systemPrompt ?? undefined }),
    });
    resetAccountsCache();
    logAudit(req, "SETTINGS_UPDATE", "MessengerAccount", accountId, { channel: "FACEBOOK", pageId, connected: existing ? "token_refreshed" : "created" });
    const sub = await subscribePageMessaging(pageId);
    if (sub.ok) logAudit(req, "SETTINGS_UPDATE", "FacebookPageSubscription", pageId, { fields: sub.fields });
    res.json({ ok: true, accountId, pageName: page.pageName, subscribed: sub.ok, ...(sub.ok ? { fields: sub.fields } : { subscribeError: sub.error }) });
  } catch (err) { next(err); }
});

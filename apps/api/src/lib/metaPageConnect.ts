import { prisma } from "../db.js";
import { logAgentAudit } from "./audit.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { resetAccountsCache, saveAccount } from "../messengers/accounts.js";
import { subscribePageWithToken, type PageSubscribeResult } from "./metaEternalTokens.js";

/**
 * ПОДКЛЮЧЕНИЕ СТРАНИЦЫ И ЕЁ INSTAGRAM — ОДНА ДВЕРЬ (13.11.2026).
 *
 * Страница Facebook становится аккаунтом CRM двумя путями:
 *  - «Подключить Messenger» — маркер Страницы от ключа компании
 *    (routes/settingsMetaEternal.ts, /pages/:pageId/connect);
 *  - «Войти через Facebook» — маркер Страницы из входа человека
 *    (lib/metaLoginAssets.ts).
 * Оба зовут эти функции: правила одни — нельзя завести вторую строку той же
 * Страницы, нельзя подключить Страницу, которая уже отвечает через основные
 * Настройки (metaPageId), «по умолчанию» новая строка не становится, бренд и
 * промт берутся у соседа той же Страницы, подписка не снимает чужие поля.
 */

export interface PageConnectInput {
  pageId: string;
  pageName: string;
  /** Маркер САМОЙ Страницы. В ответы и журнал не попадает. */
  pageToken: string;
  igId: string | null;
  /** Приложение, выдавшее маркер Страницы, — его подписку дополняем. */
  appId: string | undefined;
  /** Кто подключает (журнал). null — без сотрудника. */
  agentId: string | null;
  source: "company_key" | "facebook_login";
}

export type PageConnectResult =
  | { ok: true; accountId: string; created: boolean; subscription: PageSubscribeResult }
  | { ok: false; status: 409; error: string };

/** Основная Страница из Настроек (или окружения) — та, что отвечает без строки аккаунта. */
async function settingsPageId(): Promise<string | undefined> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageId: true } });
  return s?.metaPageId?.trim() || process.env.META_PAGE_ID || undefined;
}

/** Messenger Страницы: создать или обновить аккаунт FACEBOOK и подписать Страницу. */
export async function connectFacebookPage(input: PageConnectInput): Promise<PageConnectResult> {
  if ((await settingsPageId()) === input.pageId) {
    return { ok: false, status: 409, error: "Эта Страница уже отвечает через основные настройки Facebook." };
  }
  const existing = await prisma.messengerAccount.findFirst({
    where: { channel: "FACEBOOK", externalId: input.pageId },
    select: { id: true, isDefault: true },
  });
  const twin = input.igId
    ? await prisma.messengerAccount.findFirst({
        where: { channel: "INSTAGRAM", externalId: input.igId },
        select: { brandName: true, systemPrompt: true },
      })
    : null;
  const accountId = await saveAccount({
    id: existing?.id,
    channel: "FACEBOOK",
    externalId: input.pageId,
    title: input.pageName,
    token: input.pageToken,
    // Явно: иначе единственная строка канала стала бы «по умолчанию» и забрала
    // у основной Страницы из Настроек незнакомых получателей.
    isDefault: existing?.isDefault ?? false,
    ...(existing ? {} : { enabled: true, brandName: twin?.brandName ?? undefined, systemPrompt: twin?.systemPrompt ?? undefined }),
  });
  resetAccountsCache();
  logAgentAudit(input.agentId, "SETTINGS_UPDATE", "MessengerAccount", accountId, {
    channel: "FACEBOOK",
    pageId: input.pageId,
    connected: existing ? "token_refreshed" : "created",
    source: input.source,
  });
  const subscription = await subscribeOrReport(input.pageId, input.pageName, input.pageToken, input.appId, input.agentId, input.source);
  return { ok: true, accountId, created: !existing, subscription };
}

export interface InstagramViaPageInput {
  igId: string;
  username: string | null;
  pageId: string;
  pageName: string;
  pageToken: string;
  appId: string | undefined;
  agentId: string | null;
}

export type InstagramViaPageResult =
  | { ok: true; accountId: string; created: boolean; message: string; subscription?: PageSubscribeResult }
  | { ok: false; error: string };

/**
 * Instagram через Страницу.
 *  - Аккаунт уже есть в CRM (свой ключ входа через Instagram): только привязать
 *    Страницу, маркер НЕ трогать — он рабочий, а Страница нужна вечному пути.
 *  - Нового нет: завести аккаунт INSTAGRAM с маркером Страницы — он говорит
 *    только через Страницу (metaEternalTokens.ts::pageOnlyRoute), — и подписать
 *    Страницу, иначе сообщения Instagram не придут.
 */
export async function connectInstagramViaPage(input: InstagramViaPageInput): Promise<InstagramViaPageResult> {
  try {
    const existing = await prisma.messengerAccount.findFirst({
      where: { channel: "INSTAGRAM", externalId: input.igId },
      select: { id: true, pageId: true, title: true },
    });
    if (existing) {
      if (existing.pageId !== input.pageId) {
        await prisma.messengerAccount.update({ where: { id: existing.id }, data: { pageId: input.pageId } });
        resetAccountsCache();
        logAgentAudit(input.agentId, "SETTINGS_UPDATE", "MessengerAccount", existing.id, { pageId: input.pageId, source: "facebook_login" });
        return { ok: true, accountId: existing.id, created: false, message: `Уже был в CRM — привязан к Странице «${input.pageName}»` };
      }
      return { ok: true, accountId: existing.id, created: false, message: "Уже подключён" };
    }
    const twin = await prisma.messengerAccount.findFirst({
      where: { channel: "FACEBOOK", externalId: input.pageId },
      select: { brandName: true, systemPrompt: true },
    });
    const accountId = await saveAccount({
      channel: "INSTAGRAM",
      externalId: input.igId,
      title: input.username ? `@${input.username}` : input.pageName,
      token: input.pageToken,
      pageId: input.pageId,
      enabled: true,
      // Не «по умолчанию»: лента и публикация берут маркер основного аккаунта
      // через `/me` на graph.instagram.com, а маркер Страницы туда не годится.
      isDefault: false,
      ...(input.username ? { username: input.username } : {}),
      brandName: twin?.brandName ?? undefined,
      systemPrompt: twin?.systemPrompt ?? undefined,
    });
    resetAccountsCache();
    logAgentAudit(input.agentId, "SETTINGS_UPDATE", "MessengerAccount", accountId, {
      channel: "INSTAGRAM",
      igId: input.igId,
      pageId: input.pageId,
      connected: "created",
      source: "facebook_login",
    });
    const subscription = await subscribeOrReport(input.pageId, input.pageName, input.pageToken, input.appId, input.agentId, "facebook_login");
    return {
      ok: true,
      accountId,
      created: true,
      subscription,
      message: subscription.ok ? "Подключён, отвечает через Страницу" : `Подключён, но сообщения не придут: Страница не подписана (${subscription.error})`,
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/** Подписка Страницы с записью в журнал: успех — в историю действий, отказ Meta — в журнал ошибок. */
async function subscribeOrReport(
  pageId: string,
  pageName: string,
  pageToken: string,
  appId: string | undefined,
  agentId: string | null,
  source: PageConnectInput["source"]
): Promise<PageSubscribeResult> {
  const subscription = await subscribePageWithToken(pageId, pageToken, appId);
  if (subscription.ok) {
    logAgentAudit(agentId, "SETTINGS_UPDATE", "FacebookPageSubscription", pageId, { fields: subscription.fields, source });
  } else {
    void logSystemError("meta", `Страница «${pageName}» подключена, но не подписана на сообщения: ${subscription.error}. Настройки → Каналы → «Подписать Страницу».`);
  }
  return subscription;
}

import { prisma } from "../db.js";
import { adTopicByExternalId, isJobAdRef, isSellerAdRef, type AdTopic } from "../ai/adTemplateOpener.js";
import { adReferralPropertyId } from "../messengers/sharedMedia.js";
import { ensureMetaAdKnown } from "./ads/syncMetaAds.js";

/**
 * С КАКОЙ РЕКЛАМЫ ПРИШЁЛ ЧЕЛОВЕК — ОДНО ПРАВИЛО НА ОБА КОНВЕЙЕРА БОТА (13.11.2026).
 *
 * До этой правки метку рекламы на диалоге (BotConversation.adExternalId/adClickId/
 * adTopic/adPropertyId) писал только старый путь (messengers/conversation.ts).
 * Новое ядро (CORE) обрабатывает переписку раньше и мимо него, поэтому на проде
 * 12.11 у 29 из 30 диалогов WhatsApp с рекламы метка была пустой: бот не знал,
 * что человек пришёл с рекламы ВАКАНСИИ, и спрашивал «какой объект?», а заявка
 * теряла объект рекламы и уходила не тому агенту.
 *
 * Здесь две вещи, и обе зовут оба конвейера:
 *  - resolveAdTopic / resolveAdAttribution — о чём реклама и какой у неё объект;
 *  - firstTouchAdPatch + persistFirstTouchAdAttribution — запись первым касанием:
 *    поле пишется, только если оно ещё пустое (`where … null`), поэтому повторная
 *    доставка вебхука, второй воркер или более поздний клик ничего не перезаписывают.
 */

export interface AdReferralFacts {
  adId?: string | null;
  /** referral.ref (Instagram/Facebook) или headline + body объявления (WhatsApp). */
  adRef?: string | null;
  adClickId?: string | null;
  adPostId?: string | null;
  adTitle?: string | null;
  /** Подпись ролика из вложения — запасной путь к объекту, когда объявление не прочиталось. */
  mediaCaption?: string | null;
}

export interface AdAttribution {
  adExternalId?: string;
  adClickId?: string;
  adTopic?: AdTopic;
  adPropertyId?: string;
}

/**
 * О чём реклама. Порядок (от сильного к слабому):
 *  1. наша таблица Ad сказала «вакансия» или «для собственников» — это решение
 *     сотрудника, который заводил кампанию;
 *  2. текст объявления, который видел человек, похож на вакансию;
 *  3. текст похож на рекламу для собственников;
 *  4. реклама опознана хоть как-то — значит про объект.
 * Ничего нет — undefined: вызывающий код ведёт себя как без рекламы.
 */
export async function resolveAdTopic(facts: Pick<AdReferralFacts, "adId" | "adRef">): Promise<AdTopic | undefined> {
  const ref = (facts.adRef ?? "").trim();
  const db = facts.adId ? await adTopicByExternalId(facts.adId) : undefined;
  if (db === "job" || db === "seller") return db;
  if (isJobAdRef(ref)) return "job";
  if (isSellerAdRef(ref)) return "seller";
  return ref || db ? "property" : undefined;
}

/**
 * Полная атрибуция для записи на диалог. Объект ищется только у рекламы объекта:
 * у вакансии его нет по определению, а «объект» по подписи вакансии — ложное
 * совпадение. Никогда не бросает: атрибуция — статистика и подсказка, ответ
 * клиенту от неё не зависит.
 */
export async function resolveAdAttribution(facts: AdReferralFacts): Promise<AdAttribution> {
  const result: AdAttribution = {};
  if (facts.adId) result.adExternalId = facts.adId;
  if (facts.adClickId) result.adClickId = facts.adClickId;
  if (!facts.adId && !facts.adRef && !facts.adPostId && !facts.adTitle) return result;
  try {
    // Объявления нет в таблице Ad — догружаем его из Meta по номеру (с таймаутом
    // внутри), иначе ни тема по кампании, ни объект не находятся.
    if (facts.adId) await ensureMetaAdKnown(facts.adId);
    const topic = await resolveAdTopic(facts);
    if (topic) result.adTopic = topic;
    if (topic !== "job" && topic !== "seller") {
      const propertyId = await adReferralPropertyId({
        adId: facts.adId ?? undefined, adPostId: facts.adPostId ?? undefined,
        adTitle: facts.adTitle ?? undefined, mediaCaption: facts.mediaCaption ?? undefined,
      });
      if (propertyId) result.adPropertyId = propertyId;
    }
  } catch (err) {
    console.error("[реклама] атрибуция не разобрана:", err instanceof Error ? err.message : err);
  }
  return result;
}

type AttributionState = {
  adExternalId?: string | null; adClickId?: string | null; adTopic?: string | null; adPropertyId?: string | null;
};

/** Что из атрибуции ещё не записано на диалоге: только пустые поля, без перезаписи первого касания. */
export function firstTouchAdPatch(current: AttributionState, incoming: AdAttribution): AdAttribution {
  const patch: AdAttribution = {};
  if (incoming.adExternalId && !current.adExternalId) patch.adExternalId = incoming.adExternalId;
  if (incoming.adClickId && !current.adClickId) patch.adClickId = incoming.adClickId;
  if (incoming.adTopic && !current.adTopic) patch.adTopic = incoming.adTopic;
  if (incoming.adPropertyId && !current.adPropertyId) patch.adPropertyId = incoming.adPropertyId;
  return patch;
}

type AttributionDb = Pick<typeof prisma, "botConversation" | "client">;

/**
 * Пишет атрибуцию первым касанием. Каждое поле — отдельным условным UPDATE
 * (`… IS NULL`): два параллельных хода одного диалога не затирают друг друга, а
 * повтор ничего не меняет. Если диалог уже привязан к карточке клиента, карточке
 * без своей атрибуции достаётся это объявление (Client.sourceAdId).
 */
export async function persistFirstTouchAdAttribution(conversationId: string, attribution: AdAttribution,
  options: { clientId?: string | null; db?: AttributionDb } = {}): Promise<void> {
  const db = options.db ?? prisma;
  const { adExternalId, adClickId, adTopic, adPropertyId } = attribution;
  if (adExternalId) {
    await db.botConversation.updateMany({ where: { id: conversationId, adExternalId: null }, data: { adExternalId } });
    if (options.clientId) {
      await db.client.updateMany({ where: { id: options.clientId, sourceAdId: null }, data: { sourceAdId: adExternalId } });
    }
  }
  if (adClickId) await db.botConversation.updateMany({ where: { id: conversationId, adClickId: null }, data: { adClickId } });
  if (adTopic) await db.botConversation.updateMany({ where: { id: conversationId, adTopic: null }, data: { adTopic } });
  if (adPropertyId) await db.botConversation.updateMany({ where: { id: conversationId, adPropertyId: null }, data: { adPropertyId } });
}

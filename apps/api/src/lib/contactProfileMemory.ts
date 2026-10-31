/**
 * ПАМЯТЬ БОТА О ЧЕЛОВЕКЕ — ЗАПИСЬ ПОСЛЕ ХОДА И ЧТЕНИЕ ПЕРЕД ХОДОМ.
 *
 * Досье (lib/contactProfiles.ts) с 21.09.2026 заводится на каждого написавшего,
 * но само по себе оно копило только идентичность, язык и число касаний. Здесь —
 * вторая половина замысла владельца («карточка — основа, чтобы бот никогда не
 * путался»): что из хода попадает в досье и что из досье уходит в промт.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. `contactProfiles.ts` — про то, КТО это (связывание
 * каналов, слияния, кандидаты): у него нет и не должно быть знания ни про
 * черновик лида, ни про промт. Этот модуль стоит поверх и знает про оба.
 *
 * ОДНА ТОЧКА НА ВСЕ КАНАЛЫ — прямое требование владельца («починка в одном месте
 * обязательно работает в другом, везде одни и те же правила»). Meta и чат сайта,
 * личка Telegram, Direct Messages канала зовут ОДНИ И ТЕ ЖЕ две функции; класс
 * «защита подключена не во всех каналах» в этом репозитории уже стоил
 * незамеченных месяцев (см. CLAUDE.md).
 *
 * НИ ОДНА ФУНКЦИЯ НЕ БРОСАЕТ. Досье — это память, а не условие разговора: сбой
 * записи или чтения обязан попасть в журнал и оставить ход клиента целым.
 */

import {
  CONTACT_BUYER_FACT_LABELS,
  CONTACT_CATEGORY_LABELS,
  CONTACT_INTENT_LABELS,
  CONTACT_JOB_FACT_LABELS,
  CONTACT_SELLER_FACT_LABELS,
  categoryFromIntent,
  categoryFromWhoIsThis,
  formatClientCode,
  parseContactCategoryHistory,
  parseContactFacts,
  type ContactCategory,
  type ContactFacts,
} from "@royal-home/shared";
import type { ContactProfileForPrompt, PreviousCategory } from "../ai/contactProfileBlock.js";
import type { LeadDraft } from "../ai/leadDraft.js";
import type { SellerFacts } from "../ai/sellerIntake.js";
import { prisma } from "../db.js";
import { recordContactFacts, setContactCategory, setContactSelfName } from "./contactProfiles.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { logSystemError } from "./systemError.js";
import { sanitizeSpokenName } from "./spokenName.js";

/**
 * ЧТО ИЗ ЧЕРНОВИКА — ПРО ЧЕЛОВЕКА, А ЧТО ПРО ОДИН РАЗГОВОР.
 *
 * В досье уходят только ключи «про человека»: бюджет, район, тип, комнатность,
 * намерение. Всё остальное в `LeadDraft` по природе диалоговое — `stage`,
 * `pendingShowing`, `phoneRetryCount`, `callbackTopic`, `requestedAgentId` — и
 * обязано умирать вместе с диалогом. Записать их в память человека значило бы
 * возвращать прошлый разговор туда, где начался новый.
 */
const BUYER_KEYS = [
  "intent",
  "budgetMin",
  "budgetMax",
  "budgetUnrealistic",
  "districtName",
  "type",
  "rooms",
  "locationOutsideDushanbe",
  "locationDifferentCountry",
] as const;

/**
 * Подписи ключей для промта живут в общем словаре (`@royal-home/shared`), а не
 * здесь: те же слова печатает панель собеседника в «Чатах». Формулировки при
 * переносе не менялись — промт обязан остаться побайтово прежним.
 */
const BUYER_LABELS = CONTACT_BUYER_FACT_LABELS;
const INTENT_LABELS = CONTACT_INTENT_LABELS;
const SELLER_LABELS = CONTACT_SELLER_FACT_LABELS;
const JOB_LABELS = CONTACT_JOB_FACT_LABELS;

/**
 * ОТРИЦАТЕЛЬНЫЙ ОТВЕТ — ТОЖЕ ОТВЕТ, и для анкеты кандидата именно он решает.
 *
 * `false` по умолчанию не печатается вовсе (см. factText): для признаков продавца
 * это правильно — там `false` значит «не называл». В анкете наоборот: «не учусь» и
 * «сейчас не работаю» человек СКАЗАЛ, и по правилам отбора владельца это именно то,
 * что пропускает его дальше. Без этих строк бот не видел отрицательного ответа в
 * досье и спрашивал про учёбу и работу заново в каждом новом разговоре.
 */
const JOB_NEGATIVE_LABELS: Record<string, string> = {
  hasCar: "машины нет",
  strongMotivation: "особого желания не показал",
  studyingNow: "сейчас не учится",
  studyingUniversity: "в вузе не учится",
  employedNow: "сейчас не работает",
};

export interface RememberTurnInput {
  profileId: string | null | undefined;
  conversationId: string;
  /** Черновик ПОСЛЕ слияния с ответом модели — то, что мы теперь знаем. */
  draft?: LeadDraft | null;
  /** Что продавец назвал про объект (посчитано кодом по репликам этого диалога). */
  sellerFacts?: SellerFacts | null;
  /** Имя, которое человек назвал САМ. Имя из профиля канала сюда не передавать. */
  selfName?: string | null;
  /** Анкета кандидата — поля, зеркалящиеся в досье. */
  jobFacts?: Record<string, string | number | boolean | null | undefined> | null;
}

/**
 * ЗАПОМНИТЬ ХОД. Зовётся один раз за ход, ровно там, где канал сохраняет
 * черновик лида, — чтобы записанное в досье и записанное в диалог не могли
 * разъехаться.
 */
export async function rememberContactTurn(input: RememberTurnInput): Promise<void> {
  const profileId = input.profileId;
  if (!profileId) return;
  try {
    const draft = input.draft ?? null;

    if (input.selfName) await setContactSelfName(profileId, input.selfName);

    if (draft) {
      const values: Record<string, string | number | boolean | null | undefined> = {};
      for (const key of BUYER_KEYS) {
        // Намерение неуверенного хода («разбирать вручную») в досье не пишем: оно
        // перетёрло бы намерение, записанное уверенным ходом, а категория при этом
        // осталась бы прежней, то есть досье противоречило бы само себе (AI-DIALOGUE02).
        if (key === "intent" && draft.confident === false) continue;
        const value = (draft as unknown as Record<string, unknown>)[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          values[key] = value;
        }
      }
      await recordContactFacts({
        profileId,
        domain: "buyer",
        values,
        source: "model",
        conversationId: input.conversationId,
      });

      /**
       * Категория — только когда модель В САМОМ ДЕЛЕ поняла, кто это.
       * `confident === false` означает «разбирать вручную» (см. LeadDraft), и
       * записать по нему роль значило бы заучить догадку навсегда: снять
       * категорию потом нечем, кроме рук администратора.
       */
      /**
       * Намерение старше метки «кто это»: человек, помеченный рекламщиком, но
       * заговоривший о покупке, — покупатель. Метка добирает тех, у кого
       * намерения не бывает вовсе: рекламщик, поставщик, застройщик, ошибшийся
       * номером. До неё все они получали категорию `null` и оставались в досье
       * «Пока не понятно» навсегда, хотя бот уже понял, кто это.
       */
      const category =
        (draft.intent ? categoryFromIntent(draft.intent) : null) ??
        (draft.whoIsThis ? categoryFromWhoIsThis(draft.whoIsThis) : null);
      if (category && draft.confident !== false) {
        await setContactCategory({
          profileId,
          category,
          source: "model",
          conversationId: input.conversationId,
        });
      }
    }

    if (input.sellerFacts) {
      const named: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(input.sellerFacts)) {
        if (value) named[key] = true;
      }
      // src=guard, а не model: это счёт КОДА по репликам человека, и перезаписывать
      // им запись агента (src=agent) нельзя — за это отвечает recordContactFacts.
      await recordContactFacts({
        profileId,
        domain: "seller",
        values: named,
        source: "guard",
        conversationId: input.conversationId,
      });
    }

    if (input.jobFacts) {
      await recordContactFacts({
        profileId,
        domain: "job",
        values: input.jobFacts,
        source: "model",
        conversationId: input.conversationId,
      });
    }
  } catch (err) {
    void logSystemError("contact-profile", `не удалось запомнить ход: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-remember",
    });
  }
}

/** Значение факта человеческими словами. */
function factText(
  key: string,
  value: string | number | boolean,
  labels: Record<string, string>,
  negatives: Record<string, string> = {}
): string | null {
  const label = labels[key] ?? key;
  if (typeof value === "boolean") return value ? label : (negatives[key] ?? null);
  if (key === "intent") return `${label}: ${INTENT_LABELS[String(value)] ?? value}`;
  return `${label} ${value}`;
}

/** Факты области, кроме тех ключей, что уже есть в черновике текущего разговора. */
function factLines(
  domain: Record<string, { v: string | number | boolean }>,
  labels: Record<string, string>,
  skip: Set<string>,
  negatives: Record<string, string> = {}
): string[] {
  const out: string[] = [];
  for (const [key, fact] of Object.entries(domain)) {
    if (skip.has(key)) continue;
    const text = factText(key, fact.v, labels, negatives);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Дата по стенным часам Душанбе — «12.08.2026». Контейнер живёт в UTC, поэтому
 * день берётся через `dushanbeWallClock`, а не через локальные методы Date (общая
 * ловушка этого репозитория, см. CLAUDE.md).
 */
function dayLabel(at: Date): string {
  const wall = dushanbeWallClock(at);
  const dd = String(wall.getUTCDate()).padStart(2, "0");
  const mm = String(wall.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${wall.getUTCFullYear()}`;
}

/** «5 дней назад», «сегодня» — без часов: точность здесь ничего не решает. */
function daysAgoText(at: Date, now: Date): string {
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

/**
 * ЧТО БОТ ПРОЧИТАЕТ ПЕРЕД ХОДОМ. `null` означает «печатать нечего» — так же, как
 * пустая строка у `contactProfileBlock`: на первом в жизни сообщении человека
 * блока в промте не будет вовсе.
 *
 * `currentDraft` нужен ровно для одного: не печатать второй раз то, что уже стоит
 * в «ТЕКУЩЕЕ СОСТОЯНИЕ ДИАЛОГА». Две строки об одном бюджете — это и токены, и
 * повод модели решить, что бюджетов два.
 */
export async function contactProfileForPrompt(
  profileId: string | null | undefined,
  currentDraft: LeadDraft
): Promise<ContactProfileForPrompt | null> {
  if (!profileId) return null;
  try {
    const row = await prisma.contactProfile.findUnique({
      where: { id: profileId },
      select: {
        displayName: true,
        nameSource: true,
        category: true,
        categoryHistory: true,
        language: true,
        facts: true,
        firstSeenAt: true,
        lastSeenAt: true,
        messagesIn: true,
        /* deletedAt — обязателен: карточка в Корзине не должна звучать в промте,
         * см. `crm` ниже. */
        client: { select: { shortId: true, kind: true, deletedAt: true, assignedAgent: { select: { fullName: true } } } },
      },
    });
    if (!row) return null;

    const facts: ContactFacts = parseContactFacts(row.facts);
    const draftKeys = new Set(
      Object.entries(currentDraft as unknown as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k]) => k)
    );
    const buyer = factLines(facts.buyer, BUYER_LABELS, draftKeys);
    const seller = factLines(facts.seller, SELLER_LABELS, new Set());
    const job = factLines(facts.job, JOB_LABELS, new Set(), JOB_NEGATIVE_LABELS);

    const category = (
      CONTACT_CATEGORY_LABELS as Record<string, string>
    )[row.category]
      ? (row.category as ContactCategory)
      : "UNKNOWN";
    const previousCategories: PreviousCategory[] = [];
    for (const entry of parseContactCategoryHistory(row.categoryHistory).slice().reverse()) {
      if (entry.category === category) continue;
      if (previousCategories.some((p) => p.category === entry.category)) continue;
      previousCategories.push({ category: entry.category, when: dayLabel(new Date(entry.at)) });
      if (previousCategories.length === 2) break;
    }

    const now = new Date();
    // «Первое касание» здесь означает буквально первое: досье заводится на первом
    // же входящем, поэтому у нового человека firstSeenAt = сейчас и истории нет.
    const history =
      row.messagesIn > 1
        ? `пишет нам с ${dayLabel(row.firstSeenAt)}, ${row.messagesIn} сообщений; ` +
          `последнее — ${daysAgoText(row.lastSeenAt, now)}`
        : null;

    /**
     * КАРТОЧКА В КОРЗИНЕ БОТУ НЕ НАЗЫВАЕТСЯ (правка 22.09.2026).
     *
     * Связь `ContactProfile.clientId` переживает удаление карточки: `trashClient`
     * про досье не знает, а досье не смотрело на `deletedAt`. Бот из-за этого
     * вёл разговор как с действующим клиентом закреплённого агента по карточке,
     * которую человек удалил, — и называл её код. Само досье при этом остаётся
     * жить: переписка и факты никуда не делись, исчезает только строка «в CRM».
     */
    const crm =
      row.client && !row.client.deletedAt
        ? `${formatClientCode(row.client.shortId, row.client.kind)}` +
          (row.client.assignedAgent?.fullName ? `, агент ${row.client.assignedAgent.fullName}` : "")
        : null;

    // Чистим и при чтении (02.10.2026, lib/spokenName.ts): имя печатается в промт сырым,
    // а в досье могло лечь и до появления очистки при записи.
    const selfName =
      row.displayName && (row.nameSource === "self" || row.nameSource === "vcard") ? sanitizeSpokenName(row.displayName) : null;

    const profile: ContactProfileForPrompt = {
      category,
      previousCategories,
      selfName,
      language: row.language ?? null,
      history,
      buyer,
      seller,
      job,
      crm,
    };
    const empty =
      profile.category === "UNKNOWN" &&
      !profile.selfName &&
      !profile.language &&
      !profile.history &&
      buyer.length === 0 &&
      seller.length === 0 &&
      job.length === 0 &&
      !profile.crm;
    return empty ? null : profile;
  } catch (err) {
    void logSystemError("contact-profile", `не удалось прочитать досье для промта: ${(err as Error).message}`, {
      stack: (err as Error).stack,
      dedupKey: "contact-profile-prompt",
    });
    return null;
  }
}

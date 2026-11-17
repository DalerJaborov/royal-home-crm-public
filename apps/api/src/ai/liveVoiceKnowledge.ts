import { logSystemError } from "../lib/systemError.js";
import { learnedRulesBlock } from "../lib/botLessons.js";
import { dushanbeWallClock } from "../lib/dushanbeTime.js";
import { loadMoneyContext } from "../lib/money.js";
import { nowBlock } from "./conversationTime.js";
import { MANDATORY_BOT_RULES } from "./dushanbeGeography.js";
import { folkGeographyBlock } from "./folkPlaces.js";
import { INSPECTION_CHECKLIST_BLOCK } from "./inspectionChecklist.js";
import { resolveSellerRules } from "./agencyVoice.js";
import { LEGAL_FAQ_BLOCK } from "./legalFaq.js";
import { SALES_FACTS } from "./salesPlaybook.js";
import { agencyHoursBlock, resolveClientHours } from "./agencyFacts.js";
import { prisma } from "../db.js";

/**
 * ЗНАНИЯ ГОЛОСА — ТЕ ЖЕ, ЧТО У ЧАТ-БОТА, ИЗ ТЕХ ЖЕ МЕСТ (24.09.2026, робозвонок-
 * консультант, решение владельца: «вся база данных ИИ-бота и робозвонка должны быть
 * одинаковые»).
 *
 * До этой правки голос знал о компании три строки (AGENCY_COMPANY_INFO): название,
 * адрес, телефон. На «какая у вас комиссия», «что с документами», «Бустон Сити — это
 * где» он честно отвечал «уточню», то есть проваливал ровно те вопросы, ради которых
 * звонят в агентство.
 *
 * НИ ОДНОЙ КОПИИ. Каждый блок импортируется оттуда, где его держит чат-бот
 * (ai/leadQualifier.ts::buildStableSystem): поправили комиссию в salesPlaybook.ts —
 * поправилось в обоих каналах. Копия разошлась бы молча: оба канала согласны сами с
 * собой, и ни одна проверка не видит, что клиенту в WhatsApp и по телефону говорят
 * разное (тот же класс, что #752 в CLAUDE.md, «одно правило — одно место»).
 *
 * ЧЕГО ЗДЕСЬ НЕТ, И ПОЧЕМУ.
 *  - SELLER_INTAKE_RULES: он про переписку («напишите одним сообщением»). Смысл тот же,
 *    но для телефона — свой абзац ниже (VOICE_SELLER_INTAKE).
 *  - propertyGeographyBlock (до 300 адресов из базы): он нужен чат-боту, чтобы самому
 *    проставить район в карточке. Голосу карточку заполняет разбор расшифровки после
 *    звонка (lib/telephony/autoLeadFromCall.ts), а район для поиска квартир определяет
 *    код: ориентир словами (landmark в search_properties) разбирает lib/searchPlace.ts
 *    по карте города (с 10.10.2026; до этого район выбирала модель — аудит поиска
 *    P0-3). Народные названия голосу печатаются ЦЕЛИКОМ (folkGeographyBlock({ voice:
 *    true })): блока «места по карте» у голоса нет. Платить за этот список на каждом ходе разговора незачем: Live API
 *    перечитывает весь контекст на каждой реплике.
 *  - Предел вопросов из «Как продавать»: он против допроса в переписке, по телефону
 *    консультант уточняет по ходу (см. resolveSellerRules({ questionLimit: false })).
 */

/** Как читать справочник, написанный для переписки. Идёт ПЕРЕД ним: модель должна
 *  знать правила перевода до того, как прочтёт «пришли ссылку». */
export const VOICE_KNOWLEDGE_PREAMBLE = `

<справочник_агентства>
Ниже — справочник агентства: тот же, по которому отвечает наш чат-бот в WhatsApp и Instagram. Факты, цифры и запреты в нём действуют и для тебя целиком. Написан он для переписки, поэтому переводи его на язык телефона:
- «напиши», «пришли ссылку», «отправь фото», «одним сообщением» по телефону не бывает. Говоришь словами. Ссылки с фото и видео объектов, которые вы обсудили, шлёшь функцией send_property_sms — но только если человек согласился (она отправляет СМС на номер звонящего); там, где этой функции нет, фото и ссылки пришлёт агент.
- Поля карточки (districtName, notes и подобные) и блоки, на которые справочник ссылается, но которых здесь нет, тебя не касаются: заявку по разговору система оформит сама. Из них тебе нужна только суть: где что находится и как говорить о местах.
- Списки не зачитывай. Одна-две вещи, самые важные для этого человека, остальное — если спросит.
</справочник_агентства>`;

/** Приём объекта у продавца — по телефону. Смысл тот же, что SELLER_INTAKE_RULES
 *  (решение владельца 18.08.2026: не допрашивать продавца по одному параметру). */
export const VOICE_SELLER_INTAKE = `

<продавец_по_телефону>
Если человек предлагает свою квартиру или дом, попроси рассказать о ней своими словами, одним вопросом, а не шестью: «Расскажите про квартиру: сколько комнат, где находится, этаж, ремонт и за сколько хотите продать». Потом одной фразой уточни то, чего не хватило. Что уже сказал — не переспрашивай. Всё до последнего пункта не выжимай: неполные данные лучше потерянного собственника, остальное агент уточнит при встрече.
</продавец_по_телефону>`;

/** Всё, что читается из базы. Функция сборки ниже чистая — её можно мерить тестом. */
export interface LiveVoiceKnowledgeParts {
  folkGeography: string;
  sellerRules: string;
  learnedRules: string;
  /** null — курс не прочитался (отказ базы): строки о курсе нет вовсе. */
  usdToTjs: number | null;
  /** Настенное время Душанбе (dushanbeWallClock). */
  wallClock: Date;
  /** Окно работы агентов из Настроек (workHoursStart/End); null — не прочитались. */
  workHours?: { start: string; end: string } | null;
}

/**
 * ЧАСЫ И ОФИС — ИЗ НАСТРОЕК, А НЕ ИЗ ГОЛОВЫ (09.10.2026, робот-консультант). С 10.10
 * текст живёт в ai/agencyFacts.ts (одно окно с чатом: та же фраза о часах, тот же флаг
 * источника CLIENT_HOURS); здесь — вывоз под прежним именем.
 */
export { agencyHoursBlock };

export function buildLiveVoiceKnowledge(parts: LiveVoiceKnowledgeParts): string {
  return (
    VOICE_KNOWLEDGE_PREAMBLE +
    // Порядок как у чат-бота: народные названия ПЕРЕД обязательными правилами —
    // список жилых комплексов ссылается на «карту народных названий выше».
    parts.folkGeography +
    MANDATORY_BOT_RULES +
    SALES_FACTS +
    VOICE_SELLER_INTAKE +
    parts.sellerRules +
    LEGAL_FAQ_BLOCK +
    INSPECTION_CHECKLIST_BLOCK +
    parts.learnedRules +
    agencyHoursBlock(parts.workHours) +
    nowBlock(parts.wallClock) +
    (parts.usdToTjs
      ? `\n\nКУРС ДОЛЛАРА: 1 USD = ${parts.usdToTjs} TJS. Пересчитывай долларовые суммы в сомони только по нему.`
      : "")
  );
}

/**
 * Прочитать всё и собрать. Не бросает: отказ любого источника — пустой блок и строка
 * в журнале у самого источника, звонок идёт с тем, что есть. Лучше консультант без
 * выученных правил, чем трубка, которую никто не взял.
 */
export async function loadLiveVoiceKnowledge(now: Date = new Date()): Promise<string> {
  const safe = <T>(p: Promise<T>, fallback: T, what: string): Promise<T> =>
    p.catch((err) => {
      void logSystemError("ai", `Живой голос: ${what} не прочитан, звонок идёт без него: ${err instanceof Error ? err.message : err}`, {
        dedupKey: `live-voice-knowledge-${what}`,
      });
      return fallback;
    });
  const [folkGeography, sellerRules, learnedRules, money, hours] = await Promise.all([
    safe(folkGeographyBlock({ voice: true }), "", "справочник народных названий"),
    safe(resolveSellerRules({ questionLimit: false }), "", "блок «про нас»"),
    safe(learnedRulesBlock("voice"), "", "список выученных правил"),
    safe(loadMoneyContext(), null, "курс доллара"),
    safe(
      prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { workHoursStart: true, workHoursEnd: true, companyDaysOff: true },
      }),
      null,
      "часы работы"
    ),
  ]);
  return buildLiveVoiceKnowledge({
    folkGeography,
    sellerRules,
    learnedRules,
    // loadMoneyContext сам откатывается на запасной курс; null здесь — только отказ базы.
    usdToTjs: money?.usdToTjs ?? null,
    wallClock: dushanbeWallClock(now),
    // Источник часов — один флаг на оба бота (agencyFacts.ts::CLIENT_HOURS).
    workHours: resolveClientHours(hours),
  });
}

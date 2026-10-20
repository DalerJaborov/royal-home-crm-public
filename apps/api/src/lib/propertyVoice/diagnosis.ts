import {
  isPriceObjectionText,
  PRICE_REFUSAL_REASON,
  PROPERTY_VOICE_PRICE_REACTION_DAYS,
  type PropertyDiagnosis,
  type PropertyDiagnosisSeverity,
  type PropertyVoiceResponse,
} from "@royal-home/shared";
import { dushanbeDateString } from "../dushanbeTime.js";

/**
 * ДИАГНОЗ «ПОЧЕМУ ОБЪЕКТ НЕ ПРОДАЁТСЯ» — ЧИСТАЯ ФУНКЦИЯ (03.10.2026).
 *
 * Без ИИ и без базы: правила поверх уже собранного ответа «голоса рынка». Каждый
 * пункт — подсказка, а не приговор: в тексте нет обещаний результата, а `evidence`
 * всегда несёт цифры, на которых правило сработало, чтобы человек мог не
 * согласиться. Правило, у которого данных мало, молчит (а не угадывает), а при
 * общей нехватке данных ответ честный: «вывода нет».
 *
 * ПОРОГИ — константы ниже, каждая с причиной. Менять их надо осознанно: ложный
 * диагноз агенту стоит дороже, чем пропущенный (его перестают читать).
 */

/** Меньше стольких событий интереса — вывода делать нельзя: пять человек это ещё не картина, а случай. */
export const DIAGNOSIS_MIN_EVENTS = 5;
/** Объект в продаже меньше стольких дней без единого интереса — рано судить: первые недели интереса нет у многих. */
export const DIAGNOSIS_NO_INTEREST_DAYS = 30;
/** С этого срока полное молчание — уже красный флаг, а не повод подождать. */
export const DIAGNOSIS_NO_INTEREST_BAD_DAYS = 60;
/** «Много интереса»: столько событий за окно и ещё не меньше людей ниже. Десять касаний — уже не случайность. */
export const DIAGNOSIS_HIGH_INTEREST_EVENTS = 10;
/** Один человек, открывший ссылку десять раз, — не спрос: нужны разные люди. */
export const DIAGNOSIS_HIGH_INTEREST_PEOPLE = 3;
/** Минимум упоминаний цены, чтобы говорить о теме: одно «дорого» — мнение одного человека. */
export const DIAGNOSIS_MIN_PRICE_SIGNALS = 3;
/** Цена «преобладает», когда на неё приходится больше половины всех возражений и отказов. */
export const DIAGNOSIS_PRICE_SHARE = 0.5;
/** Снижение цены «вернуло интерес», если событий после стало в полтора раза больше … */
export const DIAGNOSIS_CUT_RETURN_RATIO = 1.5;
/** … и не меньше чем на два события: на малых числах «+1» — это шум. */
export const DIAGNOSIS_CUT_RETURN_MIN_GAIN = 2;
/** Реклама, на которую ушло меньше этой суммы (сомони), ещё не успела показать результат. */
export const DIAGNOSIS_MIN_AD_SPEND_TJS = 100;
/** Клиенты сами присылают объект: от трёх раз и от трети всех экспозиций — это спрос, а не совпадение. */
export const DIAGNOSIS_SHARED_MIN = 3;
export const DIAGNOSIS_SHARED_SHARE = 0.3;

export interface DiagnosisContext {
  /** Объект в продаже (статус «в продаже»). Не в продаже — диагноз не строим. */
  onSale: boolean;
  /** Дней в продаже (с входа в стадию); null — неизвестно. */
  daysOnSale: number | null;
}

type VoiceWithoutDiagnosis = Omit<PropertyVoiceResponse, "diagnosis">;

const SEVERITY_ORDER: Record<PropertyDiagnosisSeverity, number> = { bad: 0, warn: 1, info: 2 };

function daysWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "дней";
  if (mod10 === 1) return "день";
  if (mod10 >= 2 && mod10 <= 4) return "дня";
  return "дней";
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Сколько раз объект дошёл до показа — по таблице показов и по событиям интереса, что больше. */
function showingsCount(voice: VoiceWithoutDiagnosis): number {
  const fromEvents = voice.interest.byKind.find((k) => k.kind === "SHOWING")?.events ?? 0;
  return Math.max(voice.questions.showings.total, fromEvents);
}

function eventsOfKind(voice: VoiceWithoutDiagnosis, kind: string): number {
  return voice.interest.byKind.find((k) => k.kind === kind)?.events ?? 0;
}

/** Возражения и отказы по теме «цена» и общее число упоминаний, из которых считается доля. */
export function priceSignals(voice: VoiceWithoutDiagnosis): { price: number; total: number; evidence: string[] } {
  const q = voice.questions;
  let price = 0;
  let total = 0;
  const evidence: string[] = [];

  // Причина отказа — структурное поле карточки клиента, надёжнее слов.
  const expensiveRefusals = q.refusals.byReason.find((r) => r.key === PRICE_REFUSAL_REASON)?.count ?? 0;
  total += q.refusals.total;
  price += expensiveRefusals;
  if (q.refusals.total > 0) evidence.push(`Отказов клиентов после показа: ${q.refusals.total}, из них «дорого»: ${expensiveRefusals}`);

  const sources: { label: string; items: { text: string; count: number }[] }[] = [
    { label: "звонки", items: q.callObjections.top },
    { label: "комментарии", items: q.comments.escalated.topTexts },
    { label: "вопросы собственнику", items: q.ownerQuestions.items.map((i) => ({ text: i.question, count: 1 })) },
  ];
  if (voice.showingFeedback) {
    sources.push({ label: "после показа", items: voice.showingFeedback.redFlags });
    sources.push({ label: "цитаты покупателей", items: voice.showingFeedback.quotes.map((text) => ({ text, count: 1 })) });
  }
  for (const source of sources) {
    const all = source.items.reduce((s, i) => s + i.count, 0);
    const hits = source.items.filter((i) => isPriceObjectionText(i.text)).reduce((s, i) => s + i.count, 0);
    total += all;
    price += hits;
    if (all > 0) evidence.push(`${source.label}: про цену ${hits} из ${all}`);
  }
  return { price, total, evidence };
}

export function diagnoseProperty(voice: VoiceWithoutDiagnosis, ctx: DiagnosisContext): PropertyDiagnosis[] {
  if (!ctx.onSale) {
    return [
      {
        code: "NOT_ON_SALE",
        severity: "info",
        title: "Объект сейчас не в продаже",
        text: "Диагноз «почему не продаётся» строится только для объектов в продаже. Цифры ниже — история интереса.",
        evidence: [],
      },
    ];
  }

  const out: PropertyDiagnosis[] = [];
  const { interest, questions, bargaining, ads } = voice;
  const windowDays = voice.windowDays;
  const days = ctx.daysOnSale;

  // 1. Мало данных / полная тишина. Взаимоисключающие: «вывода нет» и «интереса нет» вместе противоречили бы друг другу.
  if (interest.events < DIAGNOSIS_MIN_EVENTS) {
    const silent =
      interest.events === 0 && interest.exposures.total === 0 && questions.comments.total === 0 && days != null && days >= DIAGNOSIS_NO_INTEREST_DAYS;
    if (silent) {
      out.push({
        code: "NO_INTEREST",
        severity: days! >= DIAGNOSIS_NO_INTEREST_BAD_DAYS ? "bad" : "warn",
        title: "Интереса к объекту нет совсем",
        text: "Объект давно в продаже, а следов интереса нет: ни ссылок, ни комментариев, ни показов. Стоит проверить фото, цену и достоверность объявления — возможно, его просто не видят или он не цепляет.",
        evidence: [
          `В продаже ${days} ${daysWord(days!)}`,
          `Событий интереса за ${windowDays} ${daysWord(windowDays)}: 0`,
          "Объект людям не отправляли и под ним не писали",
        ],
      });
    } else {
      out.push({
        code: "FEW_DATA",
        severity: "info",
        title: "Данных мало, вывода нет",
        text: "Событий интереса слишком мало, чтобы говорить о причинах: любой вывод сейчас был бы догадкой. Вернитесь к этой вкладке, когда накопится больше обращений.",
        evidence: [
          `Событий интереса за ${windowDays} ${daysWord(windowDays)}: ${interest.events} (для вывода нужно хотя бы ${DIAGNOSIS_MIN_EVENTS})`,
          ...(days != null ? [`В продаже ${days} ${daysWord(days)}`] : []),
        ],
      });
    }
  }

  // 2. Воронка застряла после ссылки.
  const showings = showingsCount(voice);
  if (interest.events >= DIAGNOSIS_HIGH_INTEREST_EVENTS && interest.people >= DIAGNOSIS_HIGH_INTEREST_PEOPLE && showings === 0) {
    out.push({
      code: "STUCK_BEFORE_SHOWING",
      severity: "warn",
      title: "Интерес есть, до показа не доходит",
      text: "Объект отправляют и открывают, но ни одного показа не назначено. Возможно, после ссылки с клиентами не связываются или им нечего предложить по времени — стоит поднять тех, кто открывал ссылку.",
      evidence: [
        `Отправлено ссылок: ${eventsOfKind(voice, "SHARE_SENT")}`,
        `Открыто клиентами: ${eventsOfKind(voice, "SHARE_OPENED")}`,
        `Показов: 0`,
        `Всего событий интереса: ${interest.events}, людей: ${interest.people}`,
      ],
    });
  }

  // 3. Возражения о цене на показах.
  const price = priceSignals(voice);
  if (
    // Возражения «на показах» бывают только у проведённых показов; назначенный или отменённый
    // их не рождает (аудит 04.10.2026, APROP02).
    questions.showings.conducted >= 1 &&
    price.price >= DIAGNOSIS_MIN_PRICE_SIGNALS &&
    price.total > 0 &&
    price.price / price.total > DIAGNOSIS_PRICE_SHARE
  ) {
    out.push({
      code: "PRICE_OBJECTIONS",
      severity: "warn",
      title: "На показах чаще всего упираются в цену",
      text: "Показы проходят, но больше половины возражений и отказов — про цену, торг или рассрочку. Это повод обсудить с собственником цену или условия, а не обещание, что снижение сработает.",
      evidence: [
        `Показов: ${questions.showings.total}, проведено: ${questions.showings.conducted}`,
        `Про цену: ${price.price} из ${price.total} (${percent(price.price / price.total)})`,
        ...price.evidence,
      ],
    });
  }

  // 4. Снижения цены не вернули интерес. Берём только изменения с полностью прошедшим окном «после»
  // и хоть какими-то событиями вокруг: ноль и ноль судить не о чем — это случай «интереса нет».
  const judged = bargaining.priceChanges.filter(
    (c) =>
      c.deltaPct != null &&
      c.deltaPct < 0 &&
      c.eventsBefore != null &&
      c.eventsAfter != null &&
      c.daysAfterObserved != null &&
      c.daysAfterObserved >= PROPERTY_VOICE_PRICE_REACTION_DAYS &&
      c.eventsBefore + c.eventsAfter > 0
  );
  const returned = (before: number, after: number) =>
    after >= before * DIAGNOSIS_CUT_RETURN_RATIO && after - before >= DIAGNOSIS_CUT_RETURN_MIN_GAIN;
  if (judged.length > 0 && judged.every((c) => !returned(c.eventsBefore!, c.eventsAfter!))) {
    out.push({
      code: "PRICE_CUT_NO_EFFECT",
      severity: "warn",
      title: "Снижение цены интерес не вернуло",
      text: `После ${judged.length === 1 ? "снижения" : "снижений"} цены событий интереса не стало заметно больше. Возможно, дело не в цене — стоит проверить фото, описание и каналы, где объект показывают.`,
      evidence: judged.map(
        (c) =>
          `${dushanbeDateString(new Date(c.at))}: цена ${c.deltaPct}% — за ${PROPERTY_VOICE_PRICE_REACTION_DAYS} ${daysWord(PROPERTY_VOICE_PRICE_REACTION_DAYS)} до: ${c.eventsBefore} событий, после: ${c.eventsAfter}`
      ),
    });
  }

  // 5. Деньги на рекламу ушли, обращений нет. Без права на деньги (`ads.moneyHidden`) расход
  // null, и правило молчит: сумма в тексте диагноза была бы тем же утечкой денег, что и поле.
  if (!ads.moneyHidden && ads.spendTjs != null && ads.spendTjs >= DIAGNOSIS_MIN_AD_SPEND_TJS && ads.conversations === 0 && ads.botConversations === 0) {
    out.push({
      code: "ADS_NO_RESPONSE",
      severity: "warn",
      title: "На рекламу потрачено, обращений нет",
      text: "По объекту шла реклама, но ни одной переписки она не принесла. Стоит посмотреть на ролик и подпись рекламы и на то, куда она ведёт.",
      evidence: [
        `Расход: ${Math.round(ads.spendTjs)} сомони`,
        `Показов рекламы: ${ads.impressions}, кликов: ${ads.clicks}`,
        "Обращений: 0",
      ],
    });
  }

  // 6. Клиенты сами присылают объект — сильный спрос.
  const shared = interest.exposures;
  if (shared.clientShared >= DIAGNOSIS_SHARED_MIN && shared.clientSharedShare != null && shared.clientSharedShare >= DIAGNOSIS_SHARED_SHARE) {
    out.push({
      code: "STRONG_DEMAND",
      severity: "info",
      title: "Клиенты сами присылают этот объект",
      text: "Люди сами приносят объект в разговор — это один из самых сильных сигналов спроса. Если нет других причин, цену лучше не торопиться снижать.",
      evidence: [
        `Клиент прислал объект сам: ${shared.clientShared} раз из ${shared.total} (${percent(shared.clientSharedShare)})`,
        `Людей среди получателей: ${shared.uniquePeople}`,
      ],
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

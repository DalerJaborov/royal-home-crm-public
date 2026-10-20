import {
  pluralizeRu,
  type OwnerReportNextStep,
  type OwnerReportPeriod,
  type OwnerReportResponse,
  type OwnerReportSaleStatus,
  type PropertyDiagnosisCode,
  type PropertyVoiceResponse,
} from "@royal-home/shared";
import { buildOwnerReportTopics, ownerReportTopicCounts } from "./topics.js";

/**
 * СБОРКА «ОТЧЁТА ВЛАДЕЛЬЦУ» — ЧИСТАЯ ФУНКЦИЯ (03.10.2026), без базы и без сети.
 *
 * Читает ровно то, что уже посчитал «голос рынка» (lib/propertyVoice/): числа за
 * неделю и за всё время, динамику по неделям и ДИАГНОЗ. Правила рекомендаций здесь
 * не копируются: пункт «следующий шаг» выбирается по КОДУ из `voice.diagnosis`
 * (lib/propertyVoice/diagnosis.ts) — порог поменяли там, поменялось и здесь.
 * Здесь только перевод «что нашло правило» в слова для собственника.
 *
 * Наружу идёт только то, что можно показать человеку без входа в CRM: числа, темы
 * и текст рекомендации. Цифры-доказательства строятся из чисел, а не из `evidence`
 * диагноза: тот написан для агента (суммы рекламы, даты изменений цены).
 *
 * Тон — подсказка и повод для разговора, а не приговор и не обещание результата.
 */

/** С какого дня в продаже «мало интереса» уже повод освежить подачу, а не ждать. */
export const OWNER_REPORT_REFRESH_AFTER_DAYS = 14;

export interface OwnerReportPeriodSource {
  /** «Голос рынка» с окном ЭТОГО периода (7 дней или всё время). */
  voice: PropertyVoiceResponse;
  /** Разных людей на связи по объекту за период (звонок, сообщение, диалог бота; один человек — один раз). */
  contacts: number;
  /** Просмотры страницы на сайте за период; null — данных от сайта нет. */
  siteViews: number | null;
}

export interface OwnerReportInput {
  now: Date;
  agency: { name: string; slogan: string; logoUrl: string | null };
  property: {
    title: string;
    rooms: number | null;
    district: string | null;
    city: string | null;
    price: number;
    currency: string;
    photoUrl: string | null;
    saleStatus: OwnerReportSaleStatus;
    daysOnSale: number | null;
  };
  week: OwnerReportPeriodSource;
  /** Окно «всё время»: по нему же — диагноз, темы и динамика по неделям. */
  all: OwnerReportPeriodSource;
}

function toPeriod(source: OwnerReportPeriodSource): OwnerReportPeriod {
  const { voice } = source;
  const ads = voice.ads;
  return {
    shownToClients: voice.interest.exposures.total,
    contacts: source.contacts,
    showings: voice.questions.showings.conducted,
    comments: voice.questions.comments.total,
    siteViews: source.siteViews,
    // Обращения из рекламы — реклама и бот описывают одно и то же с двух сторон
    // (Meta считает начатые переписки, мы — диалоги бота), поэтому берём большее, а не сумму.
    ads:
      ads.adsCount > 0
        ? { impressions: ads.impressions, inquiries: Math.max(ads.conversations, ads.botConversations) }
        : null,
  };
}

const times = (n: number) => `${n} ${pluralizeRu(n, ["раз", "раза", "раз"])}`;
const days = (n: number) => `${n} ${pluralizeRu(n, ["день", "дня", "дней"])}`;

/** Диагноз → рекомендация. Порядок = приоритет: первое сработавшее правило и есть ответ. */
const NEXT_STEP_PRIORITY: PropertyDiagnosisCode[] = [
  "NOT_ON_SALE",
  "PRICE_OBJECTIONS",
  "PRICE_CUT_NO_EFFECT",
  "NO_INTEREST",
  "STUCK_BEFORE_SHOWING",
  "ADS_NO_RESPONSE",
  "STRONG_DEMAND",
  "FEW_DATA",
];

export function buildNextStep(input: OwnerReportInput): OwnerReportNextStep {
  const { voice } = input.all;
  const period = toPeriod(input.all);
  const codes = new Set(voice.diagnosis.map((d) => d.code));
  const code = NEXT_STEP_PRIORITY.find((c) => codes.has(c));
  const daysOnSale = input.property.daysOnSale;

  const generalEvidence: string[] = [];
  if (period.shownToClients > 0) generalEvidence.push(`Объект показали клиентам: ${times(period.shownToClients)}`);
  if (period.contacts > 0) generalEvidence.push(`Контактов по объекту: ${period.contacts}`);
  if (period.showings > 0) generalEvidence.push(`Проведено показов: ${period.showings}`);
  if (daysOnSale != null) generalEvidence.push(`В продаже: ${days(daysOnSale)}`);

  switch (code) {
    case "NOT_ON_SALE":
      return {
        kind: "NOT_ON_SALE",
        title: "Объект сейчас не в продаже",
        text: "Пока объект не в продаже, рекомендаций по цене нет. Цифры на этой странице — история интереса к объекту.",
        evidence: [],
      };

    case "PRICE_OBJECTIONS": {
      const counts = ownerReportTopicCounts(voice);
      const priceMentions = (counts.get("PRICE") ?? 0) + (counts.get("BARGAIN") ?? 0);
      return {
        kind: "DISCUSS_PRICE",
        title: "Стоит обсудить цену",
        text: "Объект смотрят и приходят на показы, но чаще всего вопросы и возражения связаны с ценой или торгом. Предлагаем встретиться и вместе посмотреть, какие условия сделают предложение сильнее. Это повод для разговора, а не обещание, что снижение цены сразу даст результат.",
        evidence: [
          ...(voice.questions.showings.conducted > 0 ? [`Проведено показов: ${voice.questions.showings.conducted}`] : []),
          ...(priceMentions > 0 ? [`Вопросов и возражений про цену и торг: ${priceMentions}`] : []),
          ...generalEvidence.filter((e) => !e.startsWith("Проведено показов")),
        ],
      };
    }

    case "PRICE_CUT_NO_EFFECT":
      return {
        kind: "REFRESH_MEDIA",
        title: "Обновить фото и ролик",
        text: "После снижения цены интереса заметно не прибавилось, значит, дело, скорее всего, не только в цене. Предлагаем освежить подачу: новые фото, свежий ролик, обновлённое описание — и заново показать объект.",
        evidence: ["После снижения цены число обращений заметно не выросло", ...generalEvidence],
      };

    case "NO_INTEREST":
      return {
        kind: "REFRESH_MEDIA",
        title: "Обновить фото и ролик",
        text: "Объект давно в продаже, а откликов почти нет. Прежде чем менять цену, предлагаем проверить подачу: новые фото, свежий ролик, обновлённое описание — возможно, объект просто не цепляет с первого взгляда.",
        evidence: generalEvidence.length > 0 ? generalEvidence : ["Откликов по объекту пока нет"],
      };

    case "STUCK_BEFORE_SHOWING":
      return {
        kind: "FOLLOW_UP",
        title: "Назначить показы тем, кто интересовался",
        text: "Объект открывают и обсуждают, но до показов дело пока не дошло. Мы свяжемся с заинтересованными людьми и предложим удобное время для просмотра.",
        evidence: [...generalEvidence, "Показов пока не было"],
      };

    case "ADS_NO_RESPONSE":
      return {
        kind: "REFRESH_MEDIA",
        title: "Обновить ролик и подпись рекламы",
        text: "Реклама по объекту шла, но переписок она пока не принесла. Предлагаем обновить ролик и подпись к рекламе и проверить, куда она ведёт.",
        evidence: [
          ...(period.ads ? [`Показов рекламы: ${period.ads.impressions}`, `Обращений из рекламы: ${period.ads.inquiries}`] : []),
          ...generalEvidence,
        ],
      };

    case "STRONG_DEMAND":
      return {
        kind: "HOLD_PRICE",
        title: "Держим цену",
        text: "Объект вызывает живой интерес: клиенты сами присылают его своим знакомым. Пока спрос сильный, торопиться со снижением цены не стоит.",
        evidence: [
          `Клиенты сами прислали объект: ${times(voice.interest.exposures.clientShared)}`,
          `Людей среди получателей: ${voice.interest.exposures.uniquePeople}`,
          ...generalEvidence,
        ],
      };

    case "FEW_DATA":
      // Мало данных у давнего объекта — уже сигнал освежить подачу; у свежего — рано судить.
      if (daysOnSale != null && daysOnSale >= OWNER_REPORT_REFRESH_AFTER_DAYS) {
        return {
          kind: "REFRESH_MEDIA",
          title: "Обновить фото и ролик",
          text: "Интереса пока меньше, чем хотелось бы. Прежде чем менять цену, предлагаем освежить подачу: новые фото, свежий ролик, обновлённое описание — и заново показать объект.",
          evidence: generalEvidence,
        };
      }
      return {
        kind: "WAIT",
        title: "Пока набираем статистику",
        text: "Прошло слишком мало времени, чтобы делать выводы: любые решения сейчас были бы догадкой. Мы продолжаем показывать объект и вернёмся к цифрам, когда их станет больше.",
        evidence: generalEvidence,
      };

    default:
      return {
        kind: "KEEP_WORKING",
        title: "Продолжаем работу по плану",
        text: "Явных проблем в цифрах нет: интерес к объекту есть, мы его показываем. Продолжаем работать в том же режиме и следим за откликами.",
        evidence: generalEvidence,
      };
  }
}

export function buildOwnerReport(input: OwnerReportInput): OwnerReportResponse {
  return {
    generatedAt: input.now.toISOString(),
    agency: input.agency,
    property: input.property,
    periods: { week: toPeriod(input.week), all: toPeriod(input.all) },
    weekly: input.all.voice.interest.weekly.map((w) => ({ weekStart: w.weekStart, events: w.events, people: w.people })),
    topics: buildOwnerReportTopics(input.all.voice),
    nextStep: buildNextStep(input),
  };
}

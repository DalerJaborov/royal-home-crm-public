/**
 * ЧТО КЛИЕНТ СКАЗАЛ УЖЕ ПОСЛЕ ТОГО, КАК ДАЛ НОМЕР (жалоба владельца, разбор 30.08.2026).
 *
 * ЖАЛОБА ДОСЛОВНО: «взял контакты, а передал не всё». Разбор прода подтвердил: у
 * 27 покупателей из 60 пусты и бюджет, и район, у 33 — число комнат, хотя в
 * переписке это почти всегда сказано.
 *
 * ГДЕ ТЕРЯЛОСЬ. Приняв заявку, диалог уходит в ветку «карточка уже есть»
 * (messengers/conversation.ts). Там в карточку дописывались ровно две вещи — имя
 * вместо заглушки и дополнительные телефоны, — а `mergeDraft` не вызывался ни
 * разу: разбор ответа модели в этой ветке не происходит вовсе, она отвечает
 * дешёвой короткой репликой. Всё, что человек назвал ПОСЛЕ номера (бюджет,
 * комнаты, район, тип жилья), оставалось только текстом переписки.
 *
 * ПОЧЕМУ РАЗБИРАЕТ КОД, А НЕ МОДЕЛЬ. Ход после принятой заявки нарочно сделан
 * дешёвым (одна фраза, без инструмента и схемы), и звать ради двух чисел полный
 * квалификатор значило бы платить за каждый «спасибо». Здесь простые правила без
 * ИИ: только то, что видно однозначно.
 *
 * ГРАНИЦА ОТВЕТСТВЕННОСТИ. Модуль ничего не пишет в базу — он только читает текст
 * и возвращает найденное. Дозаполнение карточки (и только ПУСТЫХ полей — правило
 * lib/clientAutopilot.ts) делает вызывающий.
 */

import { MIN_REAL_PURCHASE_TJS } from "./moneyThresholds.js";

/** Верхняя граница здравого смысла: выше — это уже не сомони, а опечатка. */
const MAX_REAL_PURCHASE_TJS = 100_000_000;

export interface PostAcceptFacts {
  rooms?: number;
  budgetMax?: number;
  /** Тип жилья в терминах карточки (Client.desiredType). */
  type?: "APARTMENT" | "HOUSE";
}

/** «3 хона», «3-комнатная», «трёхкомнатная», «2 otoq». */
const ROOMS = /(\d)\s*[-\s]?\s*(хона|хонаг|комнат|комн(?![\p{L}\p{N}])|ком(?![\p{L}\p{N}])|otoq|уто[кқ])/iu;
const ROOMS_WORDS: [RegExp, number][] = [
  [/одноком|якхона/iu, 1],
  [/двухком|духона|дуҳона/iu, 2],
  [/тр[её]хком|сехона|сеҳона/iu, 3],
  [/четыр[её]хком|чорхона|чорҳона/iu, 4],
];

/**
 * Сумма словами клиента. Разбираем только то, что однозначно: число (с пробелами
 * или точками как разделителями тысяч) и, если есть, множитель «тысяч».
 * Доллары НЕ трогаем намеренно: без курса пересчитать нечем, а положить доллары в
 * поле сомони — это бюджет в двенадцать раз больше настоящего (ровно та ошибка,
 * от которой защищается lib/clientAutopilot.ts). Их дозаполнит разбор с ИИ.
 */
const AMOUNT = /(\d[\d\s.,]{2,})\s*(ҳазор|хазор|hazor|тыс\.?|тысяч\w*)?/giu;
const USD = /\$|доллар|dollar|у\.?е\.?/iu;
/** Цена ЗА КВАДРАТНЫЙ МЕТР («6000 за метр», «по 700 за квадрат», котлован) —
 *  не бюджет всей покупки, а цена единицы площади (см. AMOUNT-цикл ниже: тот же
 *  класс путаницы, что чинили в ai/cardFill.ts после карточки №298 15.09.2026). */
const PER_SQM_CONTEXT = /^\s*(за|\/|по)?\s*(кв\.?\s?м|квадрат|метр|м2|м²)/iu;

function parseAmount(raw: string, thousands: boolean): number | null {
  const digits = raw.replace(/[\s.,]/g, "");
  if (!digits) return null;
  const value = Number(digits) * (thousands ? 1000 : 1);
  if (!Number.isFinite(value)) return null;
  if (value < MIN_REAL_PURCHASE_TJS || value > MAX_REAL_PURCHASE_TJS) return null;
  return value;
}

/** Квартира или дом — только когда сказано прямо. */
const APARTMENT = /кварт|манзил|апартамент/iu;
// `\b` с кириллицей не работает (он про латиницу и цифры) — границы слова
// задаём просмотром вперёд/назад, см. ai/coverageGuard.ts.
const HOUSE = /(?<![\p{L}\p{N}])дом(?![\p{L}\p{N}])|ҳавлӣ|хавли|коттедж|таунхаус|хонаи ҳавлӣ/iu;

/**
 * Разбирает реплику клиента, сказанную ПОСЛЕ приёма заявки.
 *
 * @param clientText слова клиента (одна реплика или несколько, склеенных ходом).
 */
export function extractPostAcceptFacts(clientText: string): PostAcceptFacts {
  const text = clientText.trim();
  const facts: PostAcceptFacts = {};
  if (!text) return facts;

  const rooms = ROOMS.exec(text);
  if (rooms) {
    const n = Number(rooms[1]);
    if (n >= 1 && n <= 9) facts.rooms = n;
  } else {
    for (const [re, n] of ROOMS_WORDS) {
      if (re.test(text)) {
        facts.rooms = n;
        break;
      }
    }
  }

  if (!USD.test(text)) {
    AMOUNT.lastIndex = 0;
    let best: number | null = null;
    for (let m = AMOUNT.exec(text); m; m = AMOUNT.exec(text)) {
      // Число, стоящее вплотную к «хона»/«комнат», — это комнаты, а не деньги.
      const tail = text.slice(m.index + m[0].length);
      if (/^\s*(хона|комнат|otoq)/iu.test(tail)) continue;
      // Число перед «за метр/квадрат» — это цена единицы площади, а не бюджет покупки.
      if (PER_SQM_CONTEXT.test(tail)) continue;
      const value = parseAmount(m[1], Boolean(m[2]));
      if (value !== null && (best === null || value > best)) best = value;
    }
    if (best !== null) facts.budgetMax = best;
  }

  if (APARTMENT.test(text)) facts.type = "APARTMENT";
  else if (HOUSE.test(text)) facts.type = "HOUSE";

  return facts;
}

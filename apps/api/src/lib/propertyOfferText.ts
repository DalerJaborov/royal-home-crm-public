/**
 * Текст сообщения «вот подобранные объекты», которое агент отправляет клиенту из
 * карточки.
 *
 * Отдельным модулем и с языком в аргументах, потому что до 02.08.2026 текст был
 * зашит по-русски прямо в маршруте: таджикоязычный клиент, который весь диалог
 * писал «салом, хона даркор», получал от нас «Посмотрите объекты:». Бот при этом
 * язык держит — правило про язык считается кодом (см. ai/clientLanguage.ts), — и
 * расхождение выглядело так, будто с человеком говорят два разных агентства.
 *
 * ЯЗЫК БЕРЁТСЯ ИЗ ПЕРЕПИСКИ, А НЕ ИЗ КАРТОЧКИ: поля «язык клиента» у нас нет, а
 * последняя реплика — самый честный источник, тот же, по которому отвечает бот.
 *
 * ПРО НОМЕР ОБЪЕКТА. В строке стоит «№1042» не для красоты: ссылка на карточку —
 * это `/listing/by-crm/<uuid>`, и без номера сообщение выглядит как адрес из
 * тридцати шести случайных символов. Формат ссылки менять нельзя (by-crm — это
 * контракт с сайтом, он находит объявление по externalId для любого объекта,
 * опубликованного из CRM), поэтому человеку даётся то, что он может назвать в
 * разговоре: номер.
 *
 * Смесь языков и «не определили» уводятся в русский осознанно: он понятен всем, а
 * выдуманный таджикский по двум буквам хуже понятного русского.
 */

import type { ClientLanguage } from "../ai/clientLanguage.js";

export interface OfferableProperty {
  shortId: number;
  title: string;
  /** Готовая строка цены — считает вызывающий, здесь только сборка текста. */
  price: string;
  /** Публичный адрес карточки на сайте. */
  url: string;
}

/** Заголовок сообщения: единственное и множественное число на каждом языке. */
const HEADINGS: Record<"ru" | "tg", { one: string; many: string }> = {
  ru: { one: "Посмотрите объект:", many: "Посмотрите объекты:" },
  // «Вариант», а не «хона»: подборка бывает и из участка, и из магазина, а
  // «вот эти варианты» звучит так же естественно, как у живого агента.
  tg: { one: "Ана ин вариант:", many: "Ана ин вариантҳо:" },
};

/** Цена в тексте для клиента: «650 000 с.» / «$95 000» — так же, как её видит агент. */
export function formatPriceForClient(price: unknown, currency: string): string {
  const formatted = new Intl.NumberFormat("ru-RU").format(Number(price));
  return currency === "USD" ? `$${formatted}` : `${formatted} с.`;
}

export function buildPropertyOfferText(properties: OfferableProperty[], language: ClientLanguage): string {
  const heading = HEADINGS[language === "tg" ? "tg" : "ru"];
  const many = properties.length > 1;
  const lines = properties.map(
    (p, i) => `${many ? `${i + 1}) ` : ""}№${p.shortId} — ${p.title} — ${p.price}\n${p.url}`
  );
  return `${many ? heading.many : heading.one}\n\n${lines.join("\n\n")}`;
}

export interface PropertyCardItem {
  shortId: number;
  /** «2-комн» / «Дом» — собирает вызывающий из полей объекта, а не из названия: в названии бывает адрес и телефон. */
  kind: string;
  district?: string | null;
  areaSqm?: number | null;
  floor?: number | null;
  totalFloors?: number | null;
  price: string;
  url: string;
}

const NL = String.fromCharCode(10);

/**
 * Короткая карточка объекта для сообщения клиенту (26.11.2026): тип, район, площадь,
 * этаж, цена и личная ссылка. Названия и адреса здесь НЕТ нарочно: в названии бывает
 * улица или телефон собственника, а клиенту до разговора нужен только общий вид объекта.
 */
export function buildPropertyCardsText(items: PropertyCardItem[], language: ClientLanguage, caption?: string): string {
  const heading = HEADINGS[language === "tg" ? "tg" : "ru"];
  const many = items.length > 1;
  const lines = items.map((p, i) => {
    const facts = [
      p.kind,
      p.district || null,
      p.areaSqm ? `${Math.round(p.areaSqm)} м²` : null,
      p.floor ? (p.totalFloors ? `${p.floor}/${p.totalFloors} этаж` : `${p.floor} этаж`) : null,
    ].filter(Boolean).join(", ");
    return [`${many ? `${i + 1}) ` : ""}№${p.shortId} — ${facts}`, p.price, p.url].join(NL);
  });
  const lead = caption?.trim() ? `${caption.trim()}${NL}${NL}` : "";
  return `${lead}${many ? heading.many : heading.one}${NL}${NL}${lines.join(NL + NL)}`;
}

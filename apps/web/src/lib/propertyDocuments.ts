/**
 * «Документы» объекта списком галочек (решение Dan 24.09.2026).
 *
 * В базе это по-прежнему одна строка `Property.documents` (до 200 знаков):
 * её же читают подпись Reels, модерация в Telegram и ИИ, а мастер и старая форма
 * пишут туда пресеты вроде «Договор + техпаспорт». Поэтому галочки — это способ
 * прочитать и записать ту же строку, а не новое поле: старые значения
 * раскладываются по галочкам, всё незнакомое остаётся строкой «Другое».
 */

/** Документы, которые агент отмечает галочкой, — в том порядке, в каком они
 *  показываются и записываются. */
export const PROPERTY_DOCUMENTS = [
  "Договор",
  "Техпаспорт",
  "Свидетельство о собственности",
  "Доверенность",
  "Согласие супруга",
] as const;
export type PropertyDocument = (typeof PROPERTY_DOCUMENTS)[number];

/** Без них сделку не проведут: если не отмечены, карточка говорит, чего не хватает. */
export const REQUIRED_DOCUMENTS: readonly PropertyDocument[] = ["Договор", "Техпаспорт"];

/** Предел колонки на сервере (propertyUpdateSchema: documents max 200). */
const MAX_LENGTH = 200;

const ALIASES: Record<PropertyDocument, readonly string[]> = {
  Договор: ["договор", "договор купли-продажи", "договор купли продажи"],
  Техпаспорт: ["техпаспорт", "тех паспорт", "тех. паспорт", "технический паспорт"],
  "Свидетельство о собственности": [
    "свидетельство о собственности",
    "свидетельство",
    "свидетельство о регистрации",
    "сертификат",
  ],
  Доверенность: ["доверенность"],
  "Согласие супруга": ["согласие супруга", "согласие супруги", "согласие супруга(и)"],
};

/** Пресет мастера «Нет документов» — ни одной галочки, а не «другой документ». */
const NONE_WORDS = ["нет документов", "нет"];

export type ParsedDocuments = {
  have: PropertyDocument[];
  /** Всё, что не легло на галочки, — как агент это написал. */
  other: string;
};

function normalize(token: string): string {
  return token.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function parseDocuments(value: string | null | undefined): ParsedDocuments {
  const have = new Set<PropertyDocument>();
  const other: string[] = [];
  for (const raw of (value ?? "").split(/[,;+/\n]/)) {
    const token = raw.trim();
    if (!token) continue;
    const key = normalize(token);
    if (NONE_WORDS.includes(key)) continue;
    const known = PROPERTY_DOCUMENTS.find((doc) => ALIASES[doc].includes(key));
    if (known) have.add(known);
    else other.push(token);
  }
  return { have: PROPERTY_DOCUMENTS.filter((d) => have.has(d)), other: other.join(", ") };
}

/** Строка для PATCH: галочки в постоянном порядке, затем «Другое»; пусто — null. */
export function serializeDocuments(have: readonly PropertyDocument[], other: string): string | null {
  const checked = PROPERTY_DOCUMENTS.filter((d) => have.includes(d));
  const head = checked.join(", ");
  const room = MAX_LENGTH - head.length - (head ? 2 : 0);
  const tail = other.trim().slice(0, Math.max(0, room)).trim();
  const out = [head, tail].filter(Boolean).join(", ");
  return out || null;
}

export function missingRequired(have: readonly PropertyDocument[]): PropertyDocument[] {
  return REQUIRED_DOCUMENTS.filter((d) => !have.includes(d));
}

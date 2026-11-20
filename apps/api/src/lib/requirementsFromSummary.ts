import type { PropertyType } from "@royal-home/shared";

/**
 * «ВЗЯТЬ ИЗ РАЗГОВОРА» (владелец 20.11.2026, кадры карточки клиента с iPhone): «Всё о клиенте» говорит «Ищет: дом/участок,
 * 3-4 сотки, район Назди Сомон», а «Запрос покупателя» ниже — «Тип не указан · Бюджет не указан · Район не указан», и подбор
 * показывает всю базу подряд. Два блока одной карточки противоречили друг другу.
 *
 * Сводка клиента (`Client.aiInsight`, ai/scoring.ts) уже содержит строку «Ищет: …» — её составила модель по разговору. Здесь она
 * ТОЛЬКО разбирается обычным кодом, без нового вызова ИИ и без записи: функция возвращает предложение, а в поля оно попадает
 * лишь по нажатию кнопки человеком (обычный маршрут `POST /clients/:id/buyer-requirements` с его проверкой прав).
 *
 * Берутся только пустые поля запроса: то, что агент уже записал, предложением не затирается. Район, которого нет в справочнике
 * районов (Назди Сомон), в поле района не попадает — он остаётся словами в «Пожеланиях».
 */
export interface RequirementsSuggestion {
  desiredType?: PropertyType;
  desiredRooms?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: "TJS" | "USD";
  desiredDistrictId?: string;
  requirementsNotes?: string;
  /** Короткие подписи для кнопки: «дом», «3 комн.», «Исмоили Сомони». */
  labels: string[];
}

export interface RequirementsSnapshot {
  desiredType: PropertyType | null;
  desiredRooms: number | null;
  budgetMin: unknown;
  budgetMax: unknown;
  desiredDistrictId: string | null;
  hasDesiredPlaces: boolean;
  requirementsNotes: string | null;
}

const TYPE_WORDS: Array<[RegExp, PropertyType, string]> = [
  [/квартир/i, "APARTMENT", "квартира"],
  [/(^|[^а-яё])(дом|дома|коттедж|хавли|особняк)(?![а-яё])/i, "HOUSE", "дом"],
  [/участ|сотк|земл/i, "LAND", "участок"],
  [/коммерч|офис|магазин|помещени|склад/i, "COMMERCIAL", "коммерческая"],
];

/** Строка «Ищет: …» из сводки; нет — null. */
export function searchLineFromSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const match = /^\s*Ищет:\s*(.+?)\s*$/im.exec(summary);
  return match?.[1]?.trim() || null;
}

function amountFrom(raw: string, unit: string | undefined): number | null {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit ?? "").toLowerCase();
  return Math.round(u.startsWith("млн") ? n * 1_000_000 : u.startsWith("тыс") || u === "к" || u === "k" ? n * 1000 : n);
}

/** Бюджет из «до 500 тыс сомони», «от 300 до 400 тысяч», «$60000». Без слов о деньгах число бюджетом не считается. */
export function budgetFromText(text: string): { min?: number; max?: number; currency: "TJS" | "USD" } | null {
  const usd = /\$|долл|usd|у\.?\s?е/i.test(text);
  const tjs = /сомон|смн|tjs|сом(?![а-яё])/i.test(text);
  if (!usd && !tjs) return null;
  const num = String.raw`(\d[\d\s]*(?:[.,]\d+)?)\s*(тыс(?:яч)?[а-яё.]*|млн|мил[а-яё]*|к|k)?`;
  const range = new RegExp(String.raw`от\s*${num}\s*до\s*${num}`, "i").exec(text);
  const currency = usd ? "USD" : "TJS";
  if (range) {
    // «от 300 до 400 тысяч»: единица у второго числа относится к обоим.
    const min = amountFrom(range[1], range[2] ?? range[4]), max = amountFrom(range[3], range[4]);
    if (min && max && max >= min) return { min, max, currency };
  }
  const upTo = new RegExp(String.raw`до\s*${num}`, "i").exec(text);
  if (upTo) { const max = amountFrom(upTo[1], upTo[2]); if (max) return { max, currency }; }
  const from = new RegExp(String.raw`от\s*${num}`, "i").exec(text);
  if (from) { const min = amountFrom(from[1], from[2]); if (min) return { min, currency }; }
  const plain = new RegExp(String.raw`(?:^|[^\d])${num}\s*(?:сомон|смн|tjs|сом(?![а-яё])|\$|долл|usd|у\.?\s?е)`, "i").exec(text)
    ?? new RegExp(String.raw`\$\s*${num}`, "i").exec(text);
  if (plain) { const max = amountFrom(plain[1], plain[2]); if (max) return { max, currency }; }
  return null;
}

export function suggestRequirements(
  summary: string | null | undefined,
  current: RequirementsSnapshot,
  districts: ReadonlyArray<{ id: string; name: string }>,
): RequirementsSuggestion | null {
  const line = searchLineFromSummary(summary);
  if (!line) return null;
  const out: RequirementsSuggestion = { labels: [] };

  if (!current.desiredType) {
    let best: { at: number; type: PropertyType; label: string } | null = null;
    for (const [re, type, label] of TYPE_WORDS) {
      const at = line.search(re);
      if (at >= 0 && (!best || at < best.at)) best = { at, type, label };
    }
    if (best) { out.desiredType = best.type; out.labels.push(best.label); }
  }
  if (!current.desiredRooms) {
    const rooms = /(?:^|[^\d])(\d{1,2})\s*[-–]?\s*(?:комн|ком\.|к\b)/i.exec(line);
    const n = rooms ? Number(rooms[1]) : 0;
    if (n >= 1 && n <= 20) { out.desiredRooms = n; out.labels.push(`${n} комн.`); }
  }
  if (current.budgetMin == null && current.budgetMax == null) {
    const budget = budgetFromText(line);
    if (budget) {
      if (budget.min) out.budgetMin = budget.min;
      if (budget.max) out.budgetMax = budget.max;
      out.currency = budget.currency;
      out.labels.push(budget.min && budget.max ? `${budget.min}–${budget.max}` : budget.max ? `до ${budget.max}` : `от ${budget.min}`);
    }
  }
  if (!current.desiredDistrictId && !current.hasDesiredPlaces) {
    const lower = line.toLowerCase();
    const hit = districts.find((d) => d.name.trim() && lower.includes(d.name.trim().toLowerCase()));
    if (hit) { out.desiredDistrictId = hit.id; out.labels.push(hit.name); }
    else {
      const named = /район\s+([А-ЯЁA-Z][^,.;]*)/u.exec(line);
      if (named) out.labels.push(named[1].trim());
    }
  }
  // Слова клиента целиком — в «Пожелания»: сотки, неназванный в справочнике район и прочее не теряются.
  const notes = current.requirementsNotes?.trim() ?? "";
  if (out.labels.length > 0 && !notes.toLowerCase().includes(line.toLowerCase())) {
    out.requirementsNotes = notes ? `${notes}\n${line}` : line;
  }
  // Предложение должно что-то записать: одна подпись про район вне справочника, уже лежащий в «Пожеланиях», — не повод.
  const writes = out.desiredType || out.desiredRooms || out.budgetMin || out.budgetMax || out.desiredDistrictId || out.requirementsNotes;
  return writes ? out : null;
}

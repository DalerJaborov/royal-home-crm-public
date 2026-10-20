import {
  isPriceObjectionText,
  pluralizeRu,
  type PropertyDiagnosisSeverity,
  type PropertyVoiceAds,
  type PropertyVoicePriceCut,
  type PropertyVoiceResponse,
} from "@royal-home/shared";

/**
 * ПОДГОТОВКА ДАННЫХ ДЛЯ ВКЛАДКИ «ГОЛОС РЫНКА» (03.10.2026).
 *
 * Сервер считает и отдаёт `PropertyVoiceResponse`; здесь только раскладка под экран:
 * ступени воронки, строки «что спрашивают», подпись реакции на снижение цены,
 * цена обращения. Чистые функции без React — проверяются тестами без отрисовки.
 * «Нет данных» остаётся null / пустым списком: число здесь не выдумывается.
 */

// ─── Воронка интереса ──────────────────────────────────────────────────────

export type VoiceFunnelKey = "sent" | "opened" | "showing" | "deal";

export interface VoiceFunnelStep {
  key: VoiceFunnelKey;
  label: string;
  /** События (для сделки — число сделок с ценой продажи). */
  count: number;
  /** Уникальные люди; null — для ступени человека не определить (сделки). */
  people: number | null;
  /** Доля от прошлой ступени, целые %, не больше 100; null — прошлая ступень пуста. */
  shareOfPrev: number | null;
  /** Ширина полосы, 0..100: ступень с числом не пропадает с экрана (минимум 4). */
  barPct: number;
}

function interestOf(v: PropertyVoiceResponse, kind: string) {
  return v.interest.byKind.find((k) => k.kind === kind) ?? { kind, events: 0, people: 0 };
}

/** Сделка продана только в стадии COMPLETED: PENDING_APPROVAL и раньше — цена ещё не подтверждена руководителем. */
export const DEAL_SOLD_STAGE = "COMPLETED";

/** Подпись сделки по стадии: «продано» — только завершённой, остальное честно называется своим словом. */
export function dealStageLabel(stage: string): string {
  switch (stage) {
    case "COMPLETED":
      return "продано за";
    case "PENDING_APPROVAL":
      return "ждёт одобрения, цена";
    case "CONTRACT_SIGNED":
      return "договор подписан, цена";
    default:
      return "в работе, цена";
  }
}

/** Отправлено → открыто → показ → сделка. Показ — что больше: таблица показов или события интереса. */
export function buildVoiceFunnel(v: PropertyVoiceResponse): VoiceFunnelStep[] {
  const sent = interestOf(v, "SHARE_SENT");
  const opened = interestOf(v, "SHARE_OPENED");
  const showingEvents = interestOf(v, "SHOWING");
  const showings = Math.max(v.questions.showings.total, showingEvents.events);
  const showingPeople = Math.max(v.questions.showings.uniqueClients, showingEvents.people);
  const raw: Omit<VoiceFunnelStep, "shareOfPrev" | "barPct">[] = [
    { key: "sent", label: "Отправлено клиентам", count: sent.events, people: sent.people },
    { key: "opened", label: "Клиент открыл", count: opened.events, people: opened.people },
    { key: "showing", label: "Показ", count: showings, people: showingPeople },
    { key: "deal", label: "Сделка", count: v.bargaining.deals.filter((d) => d.stage === DEAL_SOLD_STAGE).length, people: null },
  ];
  const max = Math.max(1, ...raw.map((s) => s.count));
  return raw.map((s, i) => {
    const prev = i > 0 ? raw[i - 1].count : 0;
    return {
      ...s,
      shareOfPrev: i > 0 && prev > 0 ? Math.min(100, Math.round((s.count / prev) * 100)) : null,
      barPct: s.count > 0 ? Math.max(4, Math.round((s.count / max) * 100)) : 0,
    };
  });
}

/** «12%» от доли 0..1; null — доли нет (экспозиций не было). */
export function sharePercent(share: number | null): string | null {
  return share == null ? null : `${Math.round(share * 100)}%`;
}

export function daysSinceText(days: number | null): string {
  if (days == null) return "интереса не было ни разу";
  if (days === 0) return "сегодня";
  return `${days} ${pluralizeRu(days, ["день", "дня", "дней"])} назад`;
}

// ─── Динамика по неделям ───────────────────────────────────────────────────

export interface WeeklyBar {
  weekStart: string;
  events: number;
  people: number;
  /** Высота столбика, 0..100; ненулевая неделя не ниже 6, чтобы её было видно. */
  heightPct: number;
}

export function weeklyBars(weekly: PropertyVoiceResponse["interest"]["weekly"]): { bars: WeeklyBar[]; total: number; peak: number } {
  const peak = Math.max(0, ...weekly.map((w) => w.events));
  return {
    bars: weekly.map((w) => ({
      ...w,
      heightPct: w.events > 0 ? Math.max(6, Math.round((w.events / peak) * 100)) : 0,
    })),
    total: weekly.reduce((sum, w) => sum + w.events, 0),
    peak,
  };
}

/** «ГГГГ-ММ-ДД» → «ДД.ММ». */
export function weekLabel(weekStart: string): string {
  return `${weekStart.slice(8, 10)}.${weekStart.slice(5, 7)}`;
}

// ─── Что спрашивают и возражают ────────────────────────────────────────────

export type VoiceTopicSource = "comments" | "calls" | "owner";

export const VOICE_TOPIC_SOURCE_LABEL: Record<VoiceTopicSource, string> = {
  comments: "Комментарии",
  calls: "Звонки",
  owner: "Собственник",
};

export interface VoiceTopicRow {
  id: string;
  /** Цитата — телефоны в ней уже закрыты сервером. */
  text: string;
  count: number;
  source: VoiceTopicSource;
  /** Про цену, торг или рассрочку (общий словарь с диагнозом). */
  price: boolean;
}

function groupKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Частотные темы из трёх источников: комментарии, переданные человеку; возражения
 * из звонков; вопросы агентов собственнику. Вопросы собственнику сервер отдаёт
 * по одному — одинаковые сводятся здесь. Текстов «из чата» в ответе нет вообще,
 * поэтому их источника здесь нет: честнее пропуск, чем придуманная строка.
 */
export function buildVoiceTopics(v: PropertyVoiceResponse): VoiceTopicRow[] {
  const rows: VoiceTopicRow[] = [];
  for (const t of v.questions.comments.escalated.topTexts) {
    rows.push({ id: `comments:${groupKey(t.text)}`, text: t.text, count: t.count, source: "comments", price: isPriceObjectionText(t.text) });
  }
  for (const t of v.questions.callObjections.top) {
    rows.push({ id: `calls:${groupKey(t.text)}`, text: t.text, count: t.count, source: "calls", price: isPriceObjectionText(t.text) });
  }
  const owner = new Map<string, VoiceTopicRow>();
  // Подстраховка от одинаковых id (React-ключ): одинаковый текст в одном источнике сервер уже сводит,
  // но id должен быть уникален при любых данных.
  const seen = new Set<string>();
  for (const q of v.questions.ownerQuestions.items) {
    const key = groupKey(q.question);
    if (!key) continue;
    const found = owner.get(key);
    if (found) found.count += 1;
    else owner.set(key, { id: `owner:${key}`, text: q.question, count: 1, source: "owner", price: isPriceObjectionText(q.question) });
  }
  rows.push(...owner.values());
  for (const row of rows) {
    let id = row.id;
    for (let n = 2; seen.has(id); n++) id = `${row.id}#${n}`;
    seen.add(id);
    row.id = id;
  }
  const sourceOrder: Record<VoiceTopicSource, number> = { comments: 0, calls: 1, owner: 2 };
  return rows.sort((a, b) => b.count - a.count || sourceOrder[a.source] - sourceOrder[b.source] || a.text.localeCompare(b.text, "ru"));
}

// ─── Торг ──────────────────────────────────────────────────────────────────

export type PriceReactionTone = "unknown" | "pending" | "up" | "flat" | "down";

/**
 * Что стало с интересом после изменения цены. Сравниваем события за N дней до и
 * после (сервер уже посчитал); пока «после» не набралось полностью — об этом так и
 * сказано, а не «интереса нет».
 */
export function priceReaction(cut: PropertyVoicePriceCut, fullDays: number): { tone: PriceReactionTone; text: string } {
  if (cut.eventsBefore == null || cut.eventsAfter == null) {
    return { tone: "unknown", text: "изменение старше окна — сравнить нечем" };
  }
  const span = `за ${fullDays} ${pluralizeRu(fullDays, ["день", "дня", "дней"])}`;
  const pair = `${cut.eventsBefore} до и ${cut.eventsAfter} после`;
  if ((cut.daysAfterObserved ?? 0) < fullDays) {
    return { tone: "pending", text: `после изменения прошло мало времени — события ${span}: ${pair}, цифра ещё копится` };
  }
  if (cut.eventsAfter > cut.eventsBefore) return { tone: "up", text: `интереса стало больше: ${pair} (${span})` };
  if (cut.eventsAfter === cut.eventsBefore) return { tone: "flat", text: `интерес не изменился: ${pair} (${span})` };
  return { tone: "down", text: `интереса стало меньше: ${pair} (${span})` };
}

/** «−5%» / «+3%» с настоящим минусом; null — валюты разные, сравнивать нельзя. */
export function signedPercent(pct: number | null): string | null {
  if (pct == null) return null;
  const abs = Math.abs(pct).toString().replace(".", ",");
  return `${pct < 0 ? "−" : pct > 0 ? "+" : ""}${abs}%`;
}

// ─── Реклама ───────────────────────────────────────────────────────────────

/**
 * Цена одного обращения, сомони. Переписки берём из рекламной системы, а если она
 * их не отдала — из диалогов бота, начатых этой рекламой; складывать нельзя: это
 * одни и те же люди, посчитанные дважды. Нет расхода или нет обращений — null.
 */
export function costPerInquiry(ads: PropertyVoiceAds): { value: number; inquiries: number; basis: "ads" | "bot" } | null {
  if (ads.spendTjs == null || ads.spendTjs <= 0) return null;
  const basis = ads.conversations > 0 ? "ads" : ads.botConversations > 0 ? "bot" : null;
  if (!basis) return null;
  const inquiries = basis === "ads" ? ads.conversations : ads.botConversations;
  return { value: Math.round(ads.spendTjs / inquiries), inquiries, basis };
}

// ─── Диагноз ───────────────────────────────────────────────────────────────

/** Слово у карточки: цвет один не различает — у каждой серьёзности есть своё слово и значок. */
export const DIAGNOSIS_SEVERITY_WORD: Record<PropertyDiagnosisSeverity, string> = {
  bad: "Тревога",
  warn: "Внимание",
  info: "К сведению",
};

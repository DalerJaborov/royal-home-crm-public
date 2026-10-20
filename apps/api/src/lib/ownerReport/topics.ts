import {
  isPriceObjectionText,
  OWNER_REPORT_TOPIC_KEYS,
  OWNER_REPORT_TOPIC_LABELS,
  PRICE_REFUSAL_REASON,
  type OwnerReportTopic,
  type OwnerReportTopicKey,
  type PropertyVoiceResponse,
} from "@royal-home/shared";

/**
 * ТЕМЫ ВОПРОСОВ КЛИЕНТОВ ДЛЯ «ОТЧЁТА ВЛАДЕЛЬЦУ» — ЧИСТАЯ ФУНКЦИЯ (03.10.2026).
 *
 * Владельцу уходят ТЕМЫ и числа упоминаний, а не слова клиентов: ни цитат, ни имён,
 * ни телефонов. Источники — те же, что у «голоса рынка» (комментарии, переданные
 * человеку; возражения из звонков; вопросы собственнику; причина отказа «дорого»),
 * поэтому сюда приходит уже собранный ответ, а не сырая база.
 *
 * Тема «цена» — по словарю `isPriceObjectionText` из shared (он один на сервер и экран)
 * плюс нейтральные «цена?», «нарх чанд?», которые словарь возражений НЕ берёт нарочно.
 * Торг — отдельная тема и ИСКЛЮЧАЕТ цену для того же текста: иначе одно «можно ли
 * поторговаться» считалось бы дважды. Остальные темы не исключают друг друга: «какой
 * этаж и есть ли документы» — это два вопроса.
 *
 * Словари узкие: промах дешевле ложной темы, которую владелец прочтёт как факт.
 * Границы слов — через \p{L}, потому что \b в JS не знает кириллицу.
 */

function wordsRe(stems: string[]): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])(?:${stems.join("|")})`, "iu");
}

const BARGAIN_RE = wordsRe(["торг", "скидк", "уступ", "поторг", "рассрочк", "тахфиф", "савдо", "tahfif", "savdo"]);
const PRICE_NEUTRAL_RE = wordsRe([
  "цен[аыуеой]",
  "стоимост",
  "сколько\\s+стоит",
  "почём",
  "почем",
  "нарх",
  "бо\\s+чанд",
  "чанд\\s+пул",
  "qancha",
  "narx",
]);
const DOCUMENTS_RE = wordsRe([
  "документ",
  "техпаспорт",
  "тех\\.?\\s*паспорт",
  "справк",
  "кадастр",
  "прописан",
  "собственност",
  "ҳуҷҷат",
  "хуччат",
  "санад",
  "hujjat",
]);
const CONDITION_RE = wordsRe([
  "ремонт",
  "состояни",
  "мебел",
  "отоплени",
  "трещин",
  "сыр[оа]",
  "коммуникаци",
  "тамир",
  "ҳолат",
  "holat",
  "remont",
]);
const DISTRICT_RE = wordsRe([
  "район",
  "школ",
  "садик",
  "детск",
  "остановк",
  "транспорт",
  "безопасн",
  "окружени",
  "мактаб",
  "ноҳия",
  "nohiya",
]);
const FLOOR_RE = wordsRe(["этаж", "лифт", "балкон", "планировк", "қабат", "qavat"]);

/** Темы, в которые попадает один текст. Пустой массив — текст ни к какой теме не относится. */
export function topicsOfText(text: string): OwnerReportTopicKey[] {
  const out: OwnerReportTopicKey[] = [];
  if (BARGAIN_RE.test(text)) out.push("BARGAIN");
  else if (isPriceObjectionText(text) || PRICE_NEUTRAL_RE.test(text)) out.push("PRICE");
  if (DOCUMENTS_RE.test(text)) out.push("DOCUMENTS");
  if (CONDITION_RE.test(text)) out.push("CONDITION");
  if (DISTRICT_RE.test(text)) out.push("DISTRICT");
  if (FLOOR_RE.test(text)) out.push("FLOOR");
  return out;
}

/** Сколько тем показываем владельцу. */
export const OWNER_REPORT_MAX_TOPICS = 5;

type VoiceForTopics = Pick<PropertyVoiceResponse, "questions">;

/** Сколько раз прозвучала каждая тема (только ненулевые), без обрезки до пяти. */
export function ownerReportTopicCounts(voice: VoiceForTopics): Map<OwnerReportTopicKey, number> {
  const counts = new Map<OwnerReportTopicKey, number>();
  const add = (keys: OwnerReportTopicKey[], n: number) => {
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + n);
  };
  const q = voice.questions;
  for (const t of q.comments.escalated.topTexts) add(topicsOfText(t.text), t.count);
  for (const t of q.callObjections.top) add(topicsOfText(t.text), t.count);
  for (const item of q.ownerQuestions.items) add(topicsOfText(item.question), 1);
  // Причина отказа — структурное поле карточки клиента, надёжнее слов.
  const expensive = q.refusals.byReason.find((r) => r.key === PRICE_REFUSAL_REASON)?.count ?? 0;
  if (expensive > 0) add(["PRICE"], expensive);
  return counts;
}

/**
 * Темы по убыванию числа упоминаний (при равенстве — в порядке OWNER_REPORT_TOPIC_KEYS,
 * чтобы порядок был стабилен). Тексты из ответа сюда заходят и тут же забываются:
 * наружу уходит только ключ темы и число.
 */
export function buildOwnerReportTopics(voice: VoiceForTopics): OwnerReportTopic[] {
  const counts = ownerReportTopicCounts(voice);
  return OWNER_REPORT_TOPIC_KEYS.filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({ key, label: OWNER_REPORT_TOPIC_LABELS[key], count: counts.get(key)! }))
    .sort((a, b) => b.count - a.count || OWNER_REPORT_TOPIC_KEYS.indexOf(a.key) - OWNER_REPORT_TOPIC_KEYS.indexOf(b.key))
    .slice(0, OWNER_REPORT_MAX_TOPICS);
}

import { guardPrices } from "../ai/priceGuard.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";

/**
 * ЦЕНА ПОД ПОСТОМ — ТОЛЬКО ИЗ КАРТОЧКИ (16.11.2026, аудит comments.md п.8).
 *
 * Живой случай YouTube 15.11 15:46: на «Инка. Зебо. Чан. Самон» бот ответил публично
 * «Ин хона 135 520 сомонӣ аст», а в карточке объекта 1 250 000 сомони. ФАКТ (прод,
 * "PriceChange"): объект заведён 16.10 с ценой 135 520, 17.10 цену исправили на
 * 1 250 000; 135 520 × курс ≈ 1 250 000, то есть при заведении в поле сомони записали
 * долларовую сумму. ОЦЕНКА: старая цифра осталась в описании ролика YouTube (подпись
 * публикации уходит в промт рядом с карточкой), и модель взяла её.
 *
 * У ответов на комментарии сверки цен не было вовсе — ни в публичном ответе, ни в
 * личном. Здесь она та же, что у переписки (ai/priceGuard.ts), но источники уже: только
 * строка карточки и слова самого комментатора. Подпись публикации источником НЕ
 * считается — она может быть устаревшей, ровно как в этом случае.
 *
 * Вырезана фраза с ценой, а объект известен и в продаже — цену называет КОД из карточки
 * (человек спросил цену, и молчать о ней хуже). Объект продан — цену не называем вовсе
 * (решение владельца 17.09.2026: цену сделки не раскрывать).
 */
export interface CommentPriceCard {
  /** Строка карточки, как её видит модель (describeProperty). */
  line: string;
  price: number;
  currency: string;
  available: boolean;
}

export interface CommentPriceGuardResult {
  text: string;
  invented: number[];
}

function cardPriceSentence(card: CommentPriceCard, language: "ru" | "tg"): string {
  const amount = Math.round(card.price).toLocaleString("ru-RU").replace(/ /g, " ");
  if (card.currency === "USD") return language === "ru" ? `Цена этого объекта — ${amount} $.` : `Нархи ин хона ${amount} $ аст.`;
  return language === "ru" ? `Цена этого объекта — ${amount} сомони.` : `Нархи ин хона ${amount} сомонӣ аст.`;
}

/** «Продан, подберём похожий»: в личке — где она есть; у YouTube личных сообщений нет. */
function soldSentence(language: "ru" | "tg", channel?: string): string {
  const dm = channel !== "YOUTUBE";
  return language === "ru"
    ? `Этот объект уже продан. Похожий подберём${dm ? " — напишите нам в личные сообщения" : ""}.`
    : `Ин хона аллакай фурӯхта шуд. Монандашро пешниҳод мекунем${dm ? " — ба паёми шахсӣ нависед" : ""}.`;
}

export function guardCommentPrice(input: {
  /** Канал комментария: у YouTube нет личных сообщений. */
  channel?: string;
  text: string;
  card: CommentPriceCard | null;
  commentText: string;
  usdToTjs?: number;
}): CommentPriceGuardResult {
  const text = input.text.trim();
  if (!text) return { text, invented: [] };
  const guarded = guardPrices({
    bubbles: [text],
    allowedText: `${input.card?.line ?? ""}\n${input.commentText}`,
    usdToTjs: input.usdToTjs,
  });
  if (guarded.invented.length === 0) return { text, invented: [] };
  const rest = guarded.keptDespiteViolation ? "" : guarded.bubbles.join("\n").trim();
  const language = detectClientLanguage(input.commentText) === "ru" ? "ru" : "tg";
  if (input.card && !input.card.available) {
    // Продан — цену не называем; без ответа человек не остаётся (ревью #207, С4).
    const sold = soldSentence(language, input.channel);
    return { text: /фурӯхта|фурухта|продан/iu.test(rest) ? rest : [sold, rest].filter(Boolean).join(" "), invented: guarded.invented };
  }
  if (!input.card || !Number.isFinite(input.card.price) || input.card.price <= 0) {
    return { text: rest, invented: guarded.invented };
  }
  return { text: [cardPriceSentence(input.card, language), rest].filter(Boolean).join(" "), invented: guarded.invented };
}

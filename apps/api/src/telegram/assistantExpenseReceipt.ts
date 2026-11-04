import { z } from "zod";
import sharp from "sharp";
import { expenseDateSchema } from "@royal-home/shared";
import { claimAgentAiAction } from "../lib/agentAiActionCap.js";
import {
  decideExpensePhotoDraft, expenseReceiptHash, findExpensePhotoDraft, getExpenseDirector,
  markExpensePreviewDelivered, MAX_EXPENSE_RECEIPT_IMAGE_BYTES, parseExpenseReceiptEvidence, stageExpensePhotoDraft,
  type ExpenseReceiptEvidence,
} from "../lib/telegramExpenseReceipts.js";
import { extractExpenseReceipt } from "../ai/assistant/expenseReceiptExtraction.js";
import { loadAssistantSettings } from "../ai/assistant/runtime.js";
import { assistantLanguage } from "../ai/assistant/languageRouting.js";
import type { AssistantMoneyWallet } from "../ai/assistant/moneyBudget.js";
import { downloadAssistantMedia } from "./assistantMedia.js";
import { answerCallbackQuery, editMessageText, sendMessage, sendMessageWithButtons, type TelegramCallbackQuery, type TelegramIncomingMessage } from "./api.js";
import { todayExpenseDay } from "../lib/expenseWorkspace.js";

const EXPENSE_CALLBACK = /^ef:(yes|no):(ru|tg):([0-9a-f-]{36})$/u;
const expenseIntent = /^(?:\/?чек|расход|харҷ|расид)(?=$|[\s:.,!?])/iu;
const dailyExpensePhotos = 15;
const photoMessage = z.object({
  message_id: z.number().int().positive().max(2_147_483_647),
  chat: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), type: z.literal("private") }),
  from: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), is_bot: z.literal(false).optional() }),
  photo: z.array(z.object({ file_id: z.string().min(1).max(1024), file_size: z.number().int().positive().optional() })).min(1).max(20),
  caption: z.string().max(2048).optional(),
});

const copy = {
  ru: {
    unavailable: "Не получилось разобрать чек. Пришлите фото ещё раз.",
    clarify: "Пришлите фото ещё раз и в подписи уточните только то, что не прочиталось.",
    conflict: "Данные в подписи и на чеке различаются. Проверьте сумму, валюту, дату и назначение, затем пришлите фото ещё раз.",
    noPaidReceipt: "На фото не видно, что оплата прошла. Пришлите чек с итоговой суммой и датой.",
    limit: "На сегодня хватит проверок фото. Расход можно внести в CRM.",
    preview: "Записать расход по чеку?",
    category: "Категория: прочее",
    confirm: "Записать", cancel: "Отмена",
    pending: "Этот чек уже ждёт подтверждения.",
    recorded: "Записала расход и приложила чек.",
    duplicate: "Этот чек уже есть в обработке.",
    cancelled: "Отменила. Расход не записан.",
    expired: "Время на подтверждение вышло. Пришлите фото снова.",
    forbidden: "Записывать чек можно только из привязанной лички директора.",
    uncertain: "Не удалось показать результат. Нажмите кнопку ещё раз.",
  },
  tg: {
    unavailable: "Расидро хонда натавонистам. Аксро боз фиристед.",
    clarify: "Аксро боз фиристед. Дар зераш фақат он чизеро нависед, ки хонда нашуд.",
    conflict: "Навиштаатон бо расид як хел нест. Маблағ, асъор, сана ва барои чӣ буданашро санҷеду аксро боз фиристед.",
    noPaidReceipt: "Аз акс маълум нест, ки пардохт шудааст. Расидро бо маблағ ва сана фиристед.",
    limit: "Имрӯз дигар аксро санҷида наметавонам. Харҷро дар CRM нависед.",
    preview: "Ин харҷро сабт кунам?",
    category: "Гурӯҳ: дигар харҷҳо",
    confirm: "Сабт кун", cancel: "Бекор кун",
    pending: "Ин расид ҳоло дар интизори тасдиқ аст.",
    recorded: "Харҷро сабт кардам ва расидро зам кардам.",
    duplicate: "Ин расид аллакай дар санҷиш аст.",
    cancelled: "Бекор шуд. Харҷ сабт нашуд.",
    expired: "Вақти тасдиқ гузашт. Аксро боз фиристед.",
    forbidden: "Расидро фақат директор аз чати шахсии пайвастшуда сабт карда метавонад.",
    uncertain: "Натиҷаро нишон дода натавонистам. Тугмаро боз занед.",
  },
} as const;
type Language = keyof typeof copy;
type ReceiptFields = Omit<Awaited<ReturnType<typeof extractExpenseReceipt>>, "kind" | "language">;
const currencyOf = (value: string): ExpenseReceiptEvidence["currency"] | null =>
  /^(?:USD|доллар)$/iu.test(value) ? "USD" : /^(?:TJS|сомон[иӣ])$/iu.test(value) ? "TJS" : null;
function amountMinorOf(value: string): number | null {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return amount > 0 ? amount : null;
}
function validPaymentDate(value: string | null): value is string {
  return value !== null && expenseDateSchema.safeParse(value).success && value <= todayExpenseDay();
}

function manualFields(caption: string): Partial<ReceiptFields> | false {
  const input = caption.replace(expenseIntent, "").replace(/^\s*[:.]?\s*/u, "");
  const full = /^([\d.,]+)\s+(TJS|USD|сомон[иӣ]|доллар)\s+(\d{4}-\d{2}-\d{2})\s+(?:(?:за|для|барои)\s+)?(.{1,160})$/iu.exec(input);
  if (full) {
    const [, rawAmount, rawCurrency, paymentDate, purpose] = full;
    const amountMinor = amountMinorOf(rawAmount);
    return amountMinor && validPaymentDate(paymentDate)
      ? { amountMinor, currency: currencyOf(rawCurrency), paymentDate, purpose } : false;
  }
  if (!input.includes("=")) return /^\d/u.test(input) ? false : {};
  const fields: Partial<ReceiptFields> = {};
  for (const part of input.split(";")) {
    const match = /^\s*(сумма|маблағ|валюта|асъор|дата|сана|назначение|барои чӣ)\s*=\s*(.{1,160})\s*$/iu.exec(part);
    if (!match) return false;
    const value = match[2].trim();
    const key = match[1].toLowerCase();
    if (key === "сумма" || key === "маблағ") {
      if (fields.amountMinor !== undefined || !(fields.amountMinor = amountMinorOf(value))) return false;
    } else if (key === "валюта" || key === "асъор") {
      if (fields.currency !== undefined || !(fields.currency = currencyOf(value))) return false;
    } else if (key === "дата" || key === "сана") {
      if (fields.paymentDate !== undefined || !validPaymentDate(value)) return false;
      fields.paymentDate = value;
    } else {
      if (fields.purpose !== undefined || !/\p{L}/u.test(value)) return false;
      fields.purpose = value;
    }
  }
  return fields;
}

function conflictsWith(fields: ReceiptFields, manual: Partial<ReceiptFields> | false): boolean {
  return manual === false || (["amountMinor", "currency", "paymentDate", "purpose"] as const).some(key =>
    manual[key] != null && fields[key] != null && String(manual[key]).trim().toLowerCase() !== String(fields[key]).trim().toLowerCase());
}

function askMissing(fields: ReceiptFields, language: Language): string {
  const labels = language === "tg"
    ? ["маблағ=150", "асъор=TJS", "сана=YYYY-MM-DD", "барои чӣ=коғаз"]
    : ["сумма=150", "валюта=TJS", "дата=YYYY-MM-DD", "назначение=бумага"];
  const missing = [!fields.amountMinor, !fields.currency, !validPaymentDate(fields.paymentDate), !fields.purpose || !/\p{L}/u.test(fields.purpose)];
  const items = labels.filter((_, i) => missing[i]);
  const sample = items.length ? items : labels;
  return `${copy[language].clarify} «${language === "tg" ? "Расид" : "Чек"}: ${sample.join("; ")}».`;
}

function preview(evidence: ExpenseReceiptEvidence): string {
  const phrases = copy[evidence.language];
  const amount = new Intl.NumberFormat(evidence.language === "tg" ? "tg-TJ" : "ru-RU", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(evidence.amountMinor / 100);
  return [phrases.preview, `${amount} ${evidence.currency} · ${evidence.paymentDate}`,
    evidence.purpose, evidence.vendor, phrases.category].filter(Boolean).join("\n");
}

export async function handleTelegramExpenseReceipt(
  msg: TelegramIncomingMessage, agentId: string, wallet: AssistantMoneyWallet,
): Promise<boolean> {
  // Never OCR albums, copied sources, or pictures for a different/private chat owner.
  if (msg.sender_chat || msg.forward_origin || msg.forward_from_message_id || msg.is_automatic_forward || msg.media_group_id) return false;
  const parsed = photoMessage.safeParse(msg);
  if (!parsed.success || parsed.data.chat.id !== parsed.data.from.id) return false;
  const { chat, message_id: messageId, photo } = parsed.data;
  const caption = parsed.data.caption?.trim() ?? "";
  const explicit = expenseIntent.test(caption);
  if (caption && !explicit) return false;
  const actor = await getExpenseDirector(String(chat.id), agentId);
  if (!actor || !(await loadAssistantSettings()).enabled) return false;
  const captionLanguage = assistantLanguage([{ role: "user", content: caption }]);
  let language: Language = captionLanguage === "tg" || captionLanguage === "mixed" || /^(?:харҷ|расид)/iu.test(caption) ? "tg" : "ru";
  const send = (text: string) => sendMessage(actor.chatId, text, messageId);
  const manual = manualFields(caption);
  let hasDraft = false;
  try {
    let result = await findExpensePhotoDraft(actor, messageId);
    if (!result) {
      const item = photo.at(-1)!;
      if (item.file_size && item.file_size > MAX_EXPENSE_RECEIPT_IMAGE_BYTES) {
        if (explicit) await send(copy[language].unavailable);
        return explicit;
      }
      const raw = await downloadAssistantMedia(item.file_id, MAX_EXPENSE_RECEIPT_IMAGE_BYTES);
      const processor = sharp(raw, { limitInputPixels: 20_000_000, failOn: "warning" });
      const metadata = await processor.metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) {
        throw new Error("expense_receipt_invalid_image");
      }
      const image = await processor.rotate().jpeg({ quality: 88 }).toBuffer();
      if (image.length > MAX_EXPENSE_RECEIPT_IMAGE_BYTES) throw new Error("expense_receipt_image_limit");
      result = await findExpensePhotoDraft(actor, messageId, expenseReceiptHash(image));
      if (!result) {
        const cap = await claimAgentAiAction(agentId, "assistant-expense-receipt-ocr", dailyExpensePhotos);
        if (!cap.allowed) {
          if (explicit) await send(copy[language].limit);
          return explicit;
        }
        const { kind, language: imageLanguage, ...fields } = await extractExpenseReceipt(image, wallet);
        if (!explicit && imageLanguage === "tg") language = "tg";
        if (kind !== "paid_receipt") {
          if (explicit || kind === "unclear_receipt") await send(copy[language].noPaidReceipt);
          return explicit || kind === "unclear_receipt";
        }
        if (!validPaymentDate(fields.paymentDate)) fields.paymentDate = null;
        if (manual === false || conflictsWith(fields, manual)) {
          await send(copy[language].conflict);
          return true;
        }
        const combined = { ...fields, ...manual };
        const evidence = parseExpenseReceiptEvidence({ ...combined, language });
        if (!evidence) {
          await send(askMissing(combined, language));
          return true;
        }
        result = await stageExpensePhotoDraft(actor, messageId, image, evidence);
      }
    }
    hasDraft = true;
    if (result.kind === "recorded") {
      await send(copy[language].recorded);
      return true;
    }
    if (result.kind === "duplicate") {
      await send(copy[language].duplicate);
      return true;
    }
    language = result.evidence.language;
    if (conflictsWith(result.evidence, manual)) {
      await send(copy[language].conflict);
      return true;
    }
    if (!(await getExpenseDirector(actor.chatId, agentId))) return true;
    if (result.previewMessageId) {
      await send(copy[language].pending);
      return true;
    }
    const phrases = copy[language];
    const sent = await sendMessageWithButtons(actor.chatId, preview(result.evidence), [[
      { text: phrases.confirm, callback_data: `ef:yes:${language}:${result.id}` },
      { text: phrases.cancel, callback_data: `ef:no:${language}:${result.id}` },
    ]], messageId);
    await markExpensePreviewDelivered(actor, result.id, sent.message_id);
    return true;
  } catch {
    console.warn("[telegram:assistant] receipt photo preview unavailable");
    if (explicit && !hasDraft) await send(copy[language].unavailable).catch(() => {});
    return explicit || hasDraft;
  }
}

export async function handleTelegramExpenseReceiptCallback(query: TelegramCallbackQuery): Promise<boolean> {
  if (!query.data?.startsWith("ef:")) return false;
  const match = EXPENSE_CALLBACK.exec(query.data);
  const validId = z.uuid().safeParse(match?.[3]);
  const lang = match?.[2] === "tg" ? "tg" : "ru";
  const phrases = copy[lang];
  const ack = (text: string) => answerCallbackQuery(query.id, text).catch(() => {});
  if (!match || !validId.success || query.message?.chat.type !== "private"
    || !query.from?.id || !Number.isSafeInteger(query.from.id) || query.from.id <= 0 || query.message.chat.id !== query.from.id) {
    await ack(phrases.forbidden);
    return true;
  }
  try {
    const actor = await getExpenseDirector(String(query.from.id));
    if (!actor) { await ack(phrases.forbidden); return true; }
    const result = await decideExpensePhotoDraft(actor, validId.data, match[1] === "yes");
    const text = phrases[result.kind];
    await ack(text);
    if (result.kind !== "forbidden" && query.message.message_id) {
      await editMessageText(actor.chatId, query.message.message_id, text, null).catch(() => {});
    }
  } catch {
    console.warn("[telegram:assistant] receipt confirmation outcome unavailable");
    await ack(phrases.uncertain);
  }
  return true;
}

import { prisma } from "../../db.js";
import { sendDocumentFile, sendHtmlMessage, isTelegramEnabled } from "../../telegram/api.js";
import { escapeHtml } from "../../telegram/assistantReply.js";
import { automationSwitchOn } from "../automationSwitches.js";
import { crmPublicBase } from "../crmPublicUrl.js";
import { describeError } from "../describeError.js";
import { dushanbeDateTimeString } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";

/**
 * СООБЩЕНИЕ С АВТООТВЕТЧИКА → ДИРЕКТОРУ В ШАБНАМ (владелец 21.11.2026: «в нерабочее
 * время звонки пусть идут на автоответчик, потом пусть придёт на Шабнам»).
 *
 * Зовётся из processVoicemail ОДИН раз на файл: после отметки `processedAt`, а замок
 * `VoicemailMessage` (уникальное имя файла) не даёт разобрать то же сообщение дважды.
 * Получатели — только директор: номера звонивших видит он один (решение #298), поэтому
 * в сообщении номер целиком. Рубильник `voicemailToShabnamEnabled` (по умолчанию ВКЛ).
 *
 * Отказ Telegram не роняет разбор: у каждой отправки свой таймаут, ошибка уходит в
 * журнал, текст и файл летят независимо (не вышел файл — текст уже у директора).
 */

const FILE_TIMEOUT_MS = 30_000;
const TRANSCRIPT_MAX_CHARS = 1500;

export interface VoicemailShabnamInput {
  file: string;
  phone: string;
  recordedAt: Date;
  audio: Buffer;
  client: { shortId: number; fullName: string } | null;
  transcriptRu: string | null;
}

export function buildVoicemailShabnamText(input: Omit<VoicemailShabnamInput, "audio" | "file">): string {
  const base = crmPublicBase() ?? "https://crm.royalhome.tj";
  const link = input.client ? `${base}/clients/${input.client.shortId}` : `${base}/calls`;
  const phone = input.phone ? escapeHtml(input.phone) : "скрытый номер";
  const lines = [`<b>Сообщение на автоответчике</b>`, `Звонил: ${phone}`];
  if (input.client) lines.push(`Карточка: №${input.client.shortId}, ${escapeHtml(input.client.fullName)}`);
  lines.push(`Время: ${dushanbeDateTimeString(input.recordedAt)} (Душанбе)`);
  const text = input.transcriptRu?.trim();
  if (text) {
    const cut = text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_MAX_CHARS).trimEnd()}…` : text;
    lines.push("", `Сказал: ${escapeHtml(cut)}`);
  } else {
    lines.push("", "Расшифровки нет, послушайте запись ниже.");
  }
  lines.push("", `<a href="${escapeHtml(link)}">${input.client ? "Открыть карточку" : "Открыть звонки"}</a>`);
  return lines.join("\n");
}

export async function sendVoicemailToShabnam(input: VoicemailShabnamInput): Promise<void> {
  try {
    if (!(await automationSwitchOn("voicemailToShabnamEnabled"))) return;
    if (!isTelegramEnabled()) return;

    const directors = await prisma.agent.findMany({
      where: { role: "DIRECTOR", isActive: true, telegramChatId: { not: null } },
      select: { id: true, telegramChatId: true },
      take: 20,
    });
    if (directors.length === 0) return;

    const html = buildVoicemailShabnamText(input);
    for (const director of directors) {
      const chatId = director.telegramChatId;
      if (!chatId) continue;
      try {
        await sendHtmlMessage(chatId, html);
      } catch (err) {
        void logSystemError("telephony", `Сообщение автоответчика ${input.file} не дошло директору в Шабнам: ${describeError(err)}`, {
          dedupKey: "voicemail-shabnam-text-failed",
        });
        continue;
      }
      try {
        await sendDocumentFile(chatId, input.audio, input.file, undefined, FILE_TIMEOUT_MS, true);
      } catch (err) {
        void logSystemError("telephony", `Запись автоответчика ${input.file} не отправилась директору в Шабнам (текст ушёл): ${describeError(err)}`, {
          dedupKey: "voicemail-shabnam-file-failed",
        });
      }
    }
  } catch (err) {
    void logSystemError("telephony", `Отправка сообщения автоответчика ${input.file} в Шабнам не удалась: ${describeError(err)}`, {
      dedupKey: "voicemail-shabnam-failed",
    });
  }
}

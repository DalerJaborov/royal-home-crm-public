import type { ConversationMessage } from "@royal-home/shared";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { isAckOnlyMessage, isClosingOnlyMessage, isThanksOnlyMessage, isWaitOnlyMessage } from "../ai/ackOnly.js";
import { detectSpam } from "./incomingSpam.js";
import { mentionsJobSeeking } from "../ai/jobSeekerCall.js";
import { customerRecruitmentRequested } from "../ai/customerAgentRecruitmentProtocol.js";

/**
 * КЛИЕНТ НАПИСАЛ — БОТ НЕ ОТВЕТИЛ — КАРТОЧКИ НЕТ (27.11.2026, владелец: «кто оставил номер,
 * должен попасть в CRM сам»).
 *
 * Живой случай 26.11.2026, 16:30–19:33 по Душанбе: ядро бота держало ходы (HELD,
 * current_artifact_revision_mismatch), сотрудники отвечали руками из «Сообщений», и около
 * пятнадцати переписок WhatsApp остались «Без имени» без карточки. В WhatsApp номер клиента —
 * это сам отправитель (wa_id), набирать его словами человек не обязан; сторож «номер есть —
 * карточки нет» искал номер только в тексте и такие переписки не видел (журнал 14.11:
 * «WhatsApp-клиент без набранного номера сторож не видит»).
 *
 * ФАКТ, А НЕ ПРИЧИНА: смотрим не на то, почему бот промолчал (ядро держит ход, пауза
 * оператора, сбой очереди, исчерпан повтор), а на то, что после содержательной реплики
 * клиента ответа бота нет дольше UNANSWERED_GRACE_MS. Пока бот разговаривает сам, сторож в
 * разговор не лезет: заявку там оформляет сам бот, когда узнаёт цель.
 *
 * Чистая функция: решает только по переписке, базу не трогает.
 */

/** Сколько ждём ответа бота, прежде чем считать ход несостоявшимся. Обычный ход — секунды,
 *  окно склейки сообщений — до полутора минут; двадцать минут — с запасом на повтор хода. */
export const UNANSWERED_GRACE_MS = 20 * 60_000;

/** Сколько последних реплик разбираем: несостоявшийся ход всегда в хвосте переписки. */
const LOOK_BACK = 60;

/** Одно приветствие — не обращение по делу. */
const GREETING_ONLY =
  /^(?:ассалом(?:у)?\s*(?:алейкум|алайкум)?|салом(?:\s*(?:алейкум|алайкум))?|салам(?:\s*алейкум)?|привет|здравствуйте|здраствуйте|добрый\s+(?:день|вечер)|доброе\s+утро|hello|hi|salom|assalomu\s+alaykum)[\s!.,)👋🙏😊]*$/iu;

/** Голосовое или файл без подписи, записанные плейсхолдером. Голосовое — обращение (в Таджикистане голосом пишут часто). */
const VOICE_PLACEHOLDER = /^\[(?:🎤|вложение:[^\]]*(?:audio|voice)[^\]]*)\]$/iu;

/** Реплика бота (а не сотрудника и не рассылки CRM): `by` нет у старых записей — это бот (shared/conversationMessage.ts). */
function isBotReply(m: ConversationMessage): boolean {
  return m.role === "assistant" && (!m.by || m.by.kind === "bot");
}

/** Реплика самого клиента: без автора (эхо сотрудника из телефона пишется ролью user с `by`) и не тихая запись системы. */
function isClientOwn(m: ConversationMessage): boolean {
  return m.role === "user" && !m.by && !m.silentCapture && typeof m.content === "string";
}

function hasVoice(m: ConversationMessage): boolean {
  return (m.attachments ?? []).some((a) => a.kind === "audio");
}

/** Реплика по делу: не «ок/спасибо/жду/пока», не одно приветствие, не спам и не пустое вложение. */
export function substantiveClientText(m: ConversationMessage): string | null {
  const text = stripUntrusted(m.content, ["document", "video", "voice"]).trim();
  if (VOICE_PLACEHOLDER.test(text) || (!/\p{L}{2}/u.test(text) && hasVoice(m))) return text || "[🎤]";
  if (!/\p{L}{3}/u.test(text)) return null;
  if (isAckOnlyMessage(text) || isThanksOnlyMessage(text) || isClosingOnlyMessage(text) || isWaitOnlyMessage(text)) return null;
  if (GREETING_ONLY.test(text)) return null;
  if (detectSpam(text)) return null;
  return text;
}

export interface UnansweredTurn {
  /** Когда клиент написал первую реплику, оставшуюся без ответа бота. */
  at: Date;
  /** Содержательные реплики клиента без ответа — по ним приём решает направление и отсечки (аренда и т. п.). */
  texts: string[];
  /** Сотрудник ответил руками после реплики клиента (бот на паузе или его не было). */
  staffReplied: boolean;
}

/**
 * Несостоявшийся ход бота: после последнего ответа бота есть содержательные реплики клиента,
 * новее `after` (прошлая попытка сторожа или решение человека), и самой ранней из них больше
 * UNANSWERED_GRACE_MS. Разговор о работе — не заявка (анкета кандидата, а не карточка клиента).
 */
export function unansweredClientTurn(
  messages: readonly ConversationMessage[],
  after: Date | null,
  now: Date
): UnansweredTurn | null {
  const recent = messages.slice(-LOOK_BACK);
  let lastBot = -1;
  recent.forEach((m, i) => { if (isBotReply(m)) lastBot = i; });
  const tail = recent.slice(lastBot + 1);
  const texts: string[] = [];
  let firstAt: Date | null = null;
  let firstIndex = -1;
  tail.forEach((m, i) => {
    if (!isClientOwn(m) || typeof m.at !== "string") return;
    const at = new Date(m.at);
    if (Number.isNaN(at.getTime()) || (after && at <= after)) return;
    const text = substantiveClientText(m);
    if (!text) return;
    texts.push(text);
    if (!firstAt) { firstAt = at; firstIndex = i; }
  });
  if (!firstAt || texts.length === 0) return null;
  if (now.getTime() - (firstAt as Date).getTime() < UNANSWERED_GRACE_MS) return null;
  if (texts.some((t) => mentionsJobSeeking(t) || customerRecruitmentRequested(t))) return null;
  const staffReplied = tail.slice(firstIndex + 1).some((m) => m.role === "assistant" && (m.by?.kind === "agent" || m.by?.kind === "manual"));
  return { at: firstAt, texts, staffReplied };
}

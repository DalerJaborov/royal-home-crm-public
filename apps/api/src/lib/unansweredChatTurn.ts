import type { ConversationMessage } from "@royal-home/shared";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { isAckOnlyMessage, isClosingOnlyMessage, isThanksOnlyMessage, isWaitOnlyMessage } from "../ai/ackOnly.js";
import { detectSpam } from "./incomingSpam.js";
import { mentionsJobSeeking } from "../ai/jobSeekerCall.js";
import { customerRecruitmentRequested } from "../ai/customerAgentRecruitmentProtocol.js";
import { isOptOutMessage } from "./botFollowUps.js";

/**
 * КЛИЕНТ НАПИСАЛ — БОТ НЕ ОТВЕТИЛ — КАРТОЧКИ НЕТ (27.11.2026, владелец: «кто оставил номер,
 * должен попасть в CRM сам»).
 *
 * Живой случай 26.11.2026, 16:30–19:33 по Душанбе: ядро бота держало ходы (HELD,
 * current_artifact_revision_mismatch), сотрудники отвечали руками из «Сообщений», и около
 * пятнадцати переписок WhatsApp остались «Без имени» без карточки. В WhatsApp номер клиента —
 * это сам отправитель (wa_id), набирать его словами человек не обязан; сторож «номер есть —
 * карточки нет» искал номер только в тексте и такие переписки не видел.
 *
 * Эта функция только РАЗБИРАЕТ переписку (чистая, базу не трогает): какие реплики клиента после
 * последнего ответа бота содержательны и какие у их молчания есть ДОКАЗАТЕЛЬСТВА сбоя — реплика
 * записана мимо бота (heldRouting), ответил сотрудник руками. Билеты ядра (причина молчания из
 * общего списка lib/customerIntendedSilence.ts) сверяет вызывающий одним запросом на пачку:
 * отсутствие ответа само по себе сбоем не считается (ревью #497, B1) — бот молчит и нарочно.
 */

/** Сколько ждём ответа бота, прежде чем считать ход несостоявшимся. Обычный ход — секунды,
 *  окно склейки сообщений — до полутора минут; двадцать минут — с запасом на повтор хода. */
export const UNANSWERED_GRACE_MS = 20 * 60_000;

/** Сколько последних реплик разбираем: несостоявшийся ход всегда в хвосте переписки. */
const LOOK_BACK = 60;

/** Одно приветствие — не обращение по делу. */
const GREETING_ONLY =
  /^(?:ассалом(?:у)?\s*(?:алейкум|алайкум)?|салом(?:\s*(?:алейкум|алайкум))?|салам(?:\s*алейкум)?|привет|здравствуйте|здраствуйте|добрый\s+(?:день|вечер)|доброе\s+утро|hello|hi|salom|assalomu\s+alaykum)[\s!.,)👋🙏😊]*$/iu;

/** Голосовое, записанное плейсхолдером. Голосовое — обращение (в Таджикистане голосом пишут часто). */
const VOICE_PLACEHOLDER = /^\[(?:🎤|вложение:[^\]]*(?:audio|voice)[^\]]*)\]$/iu;

/** Только ссылка (чужой ролик, пост): без слов это не вопрос (тот же довод, что foreign_share_no_reply ядра). */
const LINK_ONLY = /^(?:\s*https?:\/\/\S+\s*)+$/iu;

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

/**
 * Реплика по делу. Не по делу: «ок/спасибо/жду/пока», одно приветствие, «не пишите мне», спам, одна ссылка, стикер
 * или фото без подписи (плейсхолдер без слов), вакансия. Голосовое без расшифровки — по делу.
 */
export function substantiveClientText(m: ConversationMessage): string | null {
  const text = stripUntrusted(m.content, ["document", "video", "voice"]).trim();
  if (VOICE_PLACEHOLDER.test(text) || (!/\p{L}{2}/u.test(text) && hasVoice(m))) return text || "[🎤]";
  // Плейсхолдер вложения («[📷]», «[вложение: image]», «[стикер]») без слов клиента — не обращение.
  const words = text.replace(/\[[^\]]*\]/gu, " ").trim();
  if (!/\p{L}{3}/u.test(words)) return null;
  if (LINK_ONLY.test(words)) return null;
  if (isAckOnlyMessage(words) || isThanksOnlyMessage(words) || isClosingOnlyMessage(words) || isWaitOnlyMessage(words)) return null;
  if (GREETING_ONLY.test(words) || isOptOutMessage(words)) return null;
  if (detectSpam(words)) return null;
  return words;
}

export interface UnansweredTurn {
  /** Когда клиент написал первую реплику, оставшуюся без ответа бота. */
  at: Date;
  /** Содержательные реплики клиента без ответа — по ним приём решает направление и отсечки (аренда и т. п.). */
  texts: string[];
  /** Ключи билетов ядра у этих реплик (customerPropertyAdmission.eventKey): причину молчания сверяет вызывающий. */
  eventKeys: string[];
  /** Хотя бы одна реплика записана мимо бота (ядро удержало ход до разбора, lib/customerHeldMessage.ts). */
  held: boolean;
  /** Сотрудник ответил руками после реплики клиента. */
  staffReplied: boolean;
  /** Сотрудник CRM, ответивший первым (по нему карточка уходит ему же); null — отвечали из приложения Meta. */
  staffAgentId: string | null;
}

/**
 * Несостоявшийся ход: после последнего ответа бота есть содержательные реплики клиента, новее `after`
 * (прошлая попытка сторожа или решение человека), самой ранней больше UNANSWERED_GRACE_MS. Клиент в той же
 * пачке написал «не пишите мне» или речь о работе — не заявка.
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
  const eventKeys: string[] = [];
  let held = false;
  let firstAt: Date | null = null;
  let firstIndex = -1;
  for (let i = 0; i < tail.length; i++) {
    const m = tail[i];
    if (!isClientOwn(m) || typeof m.at !== "string") continue;
    const at = new Date(m.at);
    if (Number.isNaN(at.getTime()) || (after && at <= after)) continue;
    const raw = stripUntrusted(m.content, ["document", "video", "voice"]);
    if (isOptOutMessage(raw)) return null;
    const text = substantiveClientText(m);
    if (!text) continue;
    texts.push(text);
    const key = (m as { customerPropertyAdmission?: { eventKey?: unknown } }).customerPropertyAdmission?.eventKey;
    if (typeof key === "string") eventKeys.push(key);
    if ((m as { heldRouting?: unknown }).heldRouting === true) held = true;
    if (!firstAt) { firstAt = at; firstIndex = i; }
  }
  if (!firstAt || texts.length === 0) return null;
  if (now.getTime() - firstAt.getTime() < UNANSWERED_GRACE_MS) return null;
  if (texts.some((t) => mentionsJobSeeking(t) || customerRecruitmentRequested(t))) return null;
  const staff = tail.slice(firstIndex + 1).filter((m) => m.role === "assistant" && (m.by?.kind === "agent" || m.by?.kind === "manual"));
  const agentReply = staff.find((m) => m.by?.kind === "agent");
  const staffAgentId = agentReply?.by?.kind === "agent" && agentReply.by.agentId ? agentReply.by.agentId : null;
  return { at: firstAt, texts, eventKeys, held, staffReplied: staff.length > 0, staffAgentId };
}

/**
 * ПРОВЕРЯЮЩИЕ БОТА (владелец 20.11.2026: «руководитель при тесте…»; «список проверяющих нужен, чтобы тестовые заявки не
 * уходили агентам и чтобы проверяющий мог сбросить состояние диалога и пройти сценарий заново»).
 *
 * Одна дверь: номера из Настроек (`Settings.botReviewerPhones`, экран «Бот» → «Только заявки»). С проверяющим бот говорит
 * как с клиентом, даже если это номер сотрудника (lib/customerIngressClassification.ts); его заявка карточкой НЕ становится
 * и агентам не уходит (приём заявки оператора в ядре и в старом пути); слово «сброс» начинает разговор с нуля.
 * Сравнение — по последним девяти цифрам, как везде в CRM (lib/clientPhones.ts::phoneTail).
 */
import { prisma } from "../db.js";

const tail = (phone: string): string => phone.replace(/\D/g, "").slice(-9);

/** Номера проверяющих (хвосты по 9 цифр). Сбой чтения — пустой список: проверяющий тогда просто обычный клиент. */
export async function loadReviewerTails(): Promise<ReadonlySet<string>> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botReviewerPhones: true } });
    return new Set((row?.botReviewerPhones ?? []).map(tail).filter(value => value.length === 9));
  } catch {
    return new Set();
  }
}

export async function isReviewerPhone(...phones: ReadonlyArray<string | null | undefined>): Promise<boolean> {
  const list = phones.filter((phone): phone is string => !!phone).map(tail).filter(value => value.length === 9);
  if (!list.length) return false;
  const reviewers = await loadReviewerTails();
  return list.some(value => reviewers.has(value));
}

/** Разговор проверяющего: пишет с его номера WhatsApp или он назвал свой номер в этой переписке. */
export async function isReviewerConversation(conversationId: string, peerPhone: string | null): Promise<boolean> {
  const reviewers = await loadReviewerTails();
  if (!reviewers.size) return false;
  if (peerPhone && reviewers.has(tail(peerPhone))) return true;
  try {
    const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    const texts = Array.isArray(row?.messages) ? (row!.messages as Array<{ role?: string; content?: unknown }>)
      .filter(message => message?.role === "user").map(message => String(message.content ?? "").replace(/\D/g, "")) : [];
    return texts.some(digits => [...reviewers].some(value => digits.includes(value)));
  } catch {
    return false;
  }
}

/** «Сброс» от проверяющего: разговор начинается с нуля (память оператора). */
export const REVIEWER_RESET = /^\s*\/?(?:сброс|reset|заново)\s*[.!]?\s*$/iu;

import { CornerUpLeft } from "lucide-react";
import type { ConversationMessage } from "../types";
import { stripBotHints } from "../lib/botMessages";

/**
 * Цитата над репликой: на что именно этот ответ.
 *
 * Зачем понадобилось (16.08.2026, по живой переписке владельца). Два случая, и оба
 * читаются неверно без цитаты:
 *
 *  1) Клиент нажал «ответить» на конкретное сообщение. Тогда его «да», «подходит»
 *     или «а сколько?» относится к сказанному пять реплик назад, а стоит в ленте
 *     последним — понять, о чём речь, нельзя ни агенту, ни руководителю.
 *  2) Ответ бота пришёл с задержкой: сначала окно ожидания (человек дописывает),
 *     потом время модели. За эти секунды клиент успевает написать ещё раз — и ответ
 *     оказывается НЕ под тем сообщением, на которое отвечает.
 *
 * Цитата ничего не выдумывает: она показывает реплику, которая уже есть в этой же
 * ленте. Не нашли (лента хранит последние 40 реплик, а ссылка ведёт глубже) —
 * не рисуем ничего: пустая рамка «сообщение недоступно» только сбивает.
 */

/** Одна строка цитаты: длинные сообщения обрезаем — цитата должна напоминать, а не
 *  пересказывать. */
const MAX_LENGTH = 90;

/**
 * ОБЛИК. Проп `rh2` включает цитату прототипа `.quote` (screens/messages.html:
 * полоска слева, имя жирным блоком, текст ниже) — ровно то же, что рисовали
 * утилиты Tailwind, но классами макета. Необязателен, потому что компонент
 * рендерят ещё инбокс (Messages.tsx) и мобильный диалог (MobileChatView.tsx),
 * оба пока вне `.rh2`: безусловный перевод оставил бы их цитату без стилей.
 */
export function MessageQuote({
  quoted,
  className = "",
  rh2 = false,
}: {
  quoted: ConversationMessage | undefined;
  className?: string;
  rh2?: boolean;
}) {
  if (!quoted) return null;
  // Голосовое цитируем словом «Голосовое», а не текстом расшифровки — той же
  // причиной, что и в самой реплике (см. lib/voiceAttachment.ts): расшифровка
  // агенту и в CRM не показывается нигде, цитата не исключение.
  const isVoice = quoted.attachments?.some((a) => a.kind === "audio");
  // Служебные подсказки боту из старых записей в цитату попадать не должны — по той
  // же причине, что и в саму реплику (см. lib/botMessages.ts).
  const raw = quoted.role === "user" ? stripBotHints(quoted.content) : quoted.content;
  const text = isVoice ? "" : raw.replace(/\s+/g, " ").trim();
  const preview = text
    ? text.length > MAX_LENGTH
      ? `${text.slice(0, MAX_LENGTH)}…`
      : text
    : attachmentWord(quoted);
  if (!preview) return null;

  if (rh2) {
    return (
      <span className="quote">
        <b>
          <CornerUpLeft className="i" style={{ width: 12, height: 12, verticalAlign: "-2px" }} strokeWidth={2} />{" "}
          {quoted.role === "user" ? "Клиент" : "Royal Home"}
        </b>
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {preview}
        </span>
      </span>
    );
  }

  return (
    <span
      className={`mb-1 block border-l-2 border-blue/40 pl-2 text-[13px] leading-snug text-gray-500 ${className}`}
    >
      <span className="block font-semibold text-gray-400">
        <CornerUpLeft className="mr-1 -mt-px inline h-3 w-3" strokeWidth={2} />
        {quoted.role === "user" ? "Клиент" : "Royal Home"}
      </span>
      <span className="block truncate">{preview}</span>
    </span>
  );
}

/** Цитируют и сообщение без слов — одну фотографию или голосовое. Тогда вместо
 *  текста пишем словом, что там было. */
function attachmentWord(m: ConversationMessage): string {
  const kind = m.attachments?.[0]?.kind;
  if (kind === "image") return "Фото";
  if (kind === "audio") return "Голосовое";
  if (kind === "video") return "Видео";
  if (kind === "file") return "Документ";
  return "";
}

/**
 * Поиск цитируемой реплики по идентификатору Meta.
 *
 * Ответ бота из двух пузырей лежит ОДНОЙ репликой и хранит два идентификатора
 * (`mid` и `mid2`) — клиент мог нажать «ответить» на любой из них.
 */
export function quotedMessage(
  messages: ConversationMessage[],
  replyToMid: string | undefined,
  /**
   * Место реплики в ленте. Нужно, чтобы НЕ цитировать соседа сверху.
   *
   * Замечание владельца 16.08.2026: бот цитировал каждое сообщение подряд, и
   * переписка из трёх реплик выглядела как переписка из шести. Цитата отвечает на
   * вопрос «а это на что?» — и когда ответ стоит сразу под репликой, вопроса нет:
   * человек и так видит, на что отвечают. Смысл у неё появляется, только если
   * между репликой и ответом успело вклиниться что-то ещё (клиент дописал, пока
   * бот думал; агент вмешался; ответ пришёл через час).
   *
   * Не передан — ведём себя как раньше и цитируем всегда.
   */
  index?: number,
  sourceConversationId?: string
): ConversationMessage | undefined {
  if (!replyToMid) return undefined;
  const quotedIndex = messages.findIndex((m) =>
    (!sourceConversationId || m.sourceConversationId === sourceConversationId)
    && (m.mid === replyToMid || m.mid2 === replyToMid));
  if (quotedIndex < 0) return undefined;
  if (index !== undefined && quotedIndex === index - 1) return undefined;
  return messages[quotedIndex];
}

/**
 * ЭХО ОБОГНАЛО ОТВЕТ НА ОТПРАВКУ — ЭТО ВСЁ РАВНО НАШЕ СООБЩЕНИЕ (13.10.2026).
 *
 * Своё эхо мы узнаём по `mid`: отметка `rememberOutgoingMid` и `mid` в переписке.
 * Обе появляются только ПОСЛЕ того, как Graph API ответил на отправку. Скриншот
 * владельца 13.10.2026 (Instagram, @dilnoza_l8): ответ бота записан в 14:33:16,
 * Meta отвечала на отправку восемь секунд, а эхо того же сообщения пришло в
 * 14:33:24.905 — за 16 мс до отметки (14:33:24.921). CRM приняла реплику бота за
 * ответ сотрудника из приложения и поставила паузу на 12 часов
 * (OPERATOR_ECHO_PAUSE_MS): три голосовых клиентки остались без ответа. За 14
 * дней в Instagram 115 из 695 ответов бота остались без `mid`, у всех десяти
 * найденных «ручных ответов», совпавших с текстом бота, — та же гонка.
 *
 * Поэтому, пока отметки нет, сверяем по смыслу: недавняя (окно ниже) реплика
 * бота без записанного идентификатора, в тексте которой есть текст эха, — наша.
 * Реплика пишется в переписку ДО отправки (conversation.ts, stampOutgoingMid),
 * так что в момент эха она там уже лежит. Ошибиться в эту сторону почти не на
 * чем: сотрудник, слово в слово повторивший бота в ту же минуту, ничего нового
 * клиенту не сказал, и пауза ради него не нужна.
 */

/** Сколько ждём ответа Graph API на отправку. С запасом к живому случаю (8 с) и
 *  к таймауту исходящих запросов. */
export const IN_FLIGHT_ECHO_WINDOW_MS = 2 * 60 * 1000;

/** Сколько последних реплик смотреть: клиент успевает дописать, пока идёт отправка. */
const LOOKBACK = 6;

export type EchoHistoryEntry = {
  role?: string;
  content?: unknown;
  at?: unknown;
  by?: { kind?: string } | null;
  mid?: string;
  mid2?: string;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isOwnInFlightEcho(history: EchoHistoryEntry[], echoText: string | undefined, now: number): boolean {
  const echo = normalize(echoText ?? "");
  if (!echo) return false;
  for (const entry of history.slice(-LOOKBACK)) {
    if (entry.role !== "assistant" || entry.by?.kind !== "bot") continue;
    // Оба пузыря уже узнаны по mid — эту реплику эхо больше не касается.
    if (entry.mid && entry.mid2) continue;
    const at = typeof entry.at === "string" ? Date.parse(entry.at) : NaN;
    if (!Number.isFinite(at) || Math.abs(now - at) > IN_FLIGHT_ECHO_WINDOW_MS) continue;
    if (typeof entry.content !== "string") continue;
    // Совпадение ЦЕЛИКОМ — со всей репликой или с одним её пузырём (пузыри лежат
    // через перевод строки). Не «содержит»: короткий ответ сотрудника («Хорошо»),
    // совпавший с куском текста бота, иначе сошёл бы за эхо и паузы бы не было
    // (замечание аудита Codex 13.10.2026).
    const bubbles = [entry.content, ...entry.content.split(/\n+/)].map(normalize);
    if (bubbles.includes(echo)) return true;
  }
  return false;
}

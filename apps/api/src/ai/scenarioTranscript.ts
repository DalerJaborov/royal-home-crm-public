import { BW, EW } from "./wordBoundary.js";

/**
 * Разбор расшифровки сценарного звонка робота (опрос после показа, проверка
 * продавца): реплики клиента и признаки автоответчика. Проверка цитат — в
 * ai/callQuoteCheck.ts (второй копии здесь нет).
 * Расшифровка — строки «Клиент: …» / «Бот: …» (см. LiveVoiceScenarioResult).
 */

/** Только реплики собеседника, без префикса «Клиент:». */
export function clientLinesOf(transcript: string[]): string[] {
  const lines: string[] = [];
  for (const line of transcript) {
    const match = /^\s*Клиент\s*:\s*(.*)$/isu.exec(line);
    if (match && match[1]!.trim()) lines.push(match[1]!.trim());
  }
  return lines;
}

const VOICEMAIL_RE = new RegExp(
  [
    `${BW}абонент${EW}.{0,40}${BW}(?:недоступ|выключен|вне зоны)`,
    `${BW}аппарат${EW}.{0,30}${BW}выключен`,
    `${BW}оставьте${EW}.{0,20}${BW}сообщени`,
    `${BW}после${EW}.{0,10}${BW}сигнал`,
    `${BW}вне${EW}.{0,10}${BW}зоны${EW}.{0,10}${BW}действия`,
    `${BW}номер${EW}.{0,20}${BW}не${EW}.{0,10}${BW}обслуживается`,
    `${BW}абонент${EW}.{0,30}${BW}дастрас${EW}.{0,10}${BW}нест`,
    `${BW}пас${EW}.{0,5}${BW}аз${EW}.{0,5}${BW}сигнал`,
    `${BW}паём${EW}.{0,30}${BW}гузоред`,
    `${BW}хомӯш${EW}.{0,30}${BW}муштарӣ`,
  ].join("|"),
  "iu"
);

/** Реплики «клиента» выглядят как фраза автоответчика оператора. */
export function looksLikeVoicemail(clientLines: string[]): boolean {
  return clientLines.some((line) => VOICEMAIL_RE.test(line));
}

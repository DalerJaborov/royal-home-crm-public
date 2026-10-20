/** Причина отказа сервера вместо «Попробуйте ещё раз» (аудит 23.09.2026, №57):
 *  повтор того же действия упирается в тот же отказ, а причина («лид уже принят»,
 *  «агент на паузе») подсказывает, что делать. */
export function assignLeadErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? `${fallback} ${message}` : `${fallback} Попробуйте ещё раз.`;
}

/** «12:40» — сколько осталось (или сколько уже ждёт): минуты без ведущего нуля, секунды двумя цифрами. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

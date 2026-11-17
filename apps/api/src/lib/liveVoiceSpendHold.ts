/**
 * ПАМЯТЬ «ПОТОЛОК МИНУТ РОБОТА ДОСТИГНУТ» (П5, 11.11.2026) — без импортов нарочно.
 *
 * Пишет её только lib/liveVoiceSpend.ts (refreshLiveVoiceSpend: тик раз в минуту в
 * процессе api и каждая проверка двери перед набором), читает ai/liveVoiceProvider.ts
 * (elevenLabsQuotaExhausted) — та же дверь «у ElevenLabs нет минут», через которую мост
 * не берёт входящий и не набирает исходящий. Отдельный модуль без зависимостей, чтобы
 * поставщик голоса не тянул за собой базу и очередь тревог (и не было цикла импортов).
 *
 * Удержание гаснет само в конце периода (`until`): заснувший тик не держит робота
 * навсегда, а исходящие всё равно перепроверяет по базе дверь robotCallAllowed.
 */

export interface LiveVoiceSpendHold {
  period: "day" | "month";
  /** До какого момента (мс) держать: конец суток или месяца по Душанбе. */
  until: number;
}

let hold: LiveVoiceSpendHold | null = null;

export function setLiveVoiceSpendHold(next: LiveVoiceSpendHold | null): void {
  hold = next;
}

/** Потолок минут держит робота прямо сейчас. */
export function liveVoiceSpendCapHeld(now: number = Date.now()): boolean {
  return hold !== null && now < hold.until;
}

export function liveVoiceSpendHoldState(): LiveVoiceSpendHold | null {
  return hold;
}

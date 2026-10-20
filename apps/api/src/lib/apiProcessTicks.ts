/**
 * ТИКИ, КОТОРЫЕ ЖИВУТ В ПРОЦЕССЕ API, А НЕ В WORKER (№171 ночной проверки 24.09).
 *
 * Большинство задач по расписанию ставит cron.ts в контейнере worker, и сторож
 * пульса (`checkCronHeartbeats`, тоже в worker) знает их по своему реестру. Но
 * несколько тиков обязаны жить рядом с памятью HTTP-процесса: досчёт живых
 * звонков (`live-calls-sweep`, index.ts) и робозвонки живым голосом
 * (lib/telephony/liveVoiceScenarioTicks.ts, 28.09.2026). В реестре worker'а их
 * нет — и сторож не видел, когда такой тик тихо умирал, хотя его строка пульса
 * в базе честно старела.
 *
 * Этот список — одно место для обеих сторон: процесс api берёт отсюда
 * расписание, сторож — что ждать и как часто. Модуль намеренно без импортов:
 * его читает worker, а тянуть в worker телефонию api нельзя (см.
 * tests/live-voice-ticks-process.test.ts).
 */
export const API_PROCESS_TICKS = {
  "live-calls-sweep": "*/5 * * * *",
  // Карта живых звонков (E2/E3 глубокой проверки 02.10.2026) —
  // lib/telephony/callMemoryTicks.ts; выражения там же строкой, сверка — тестом.
  "stuck-call-stubs": "*/5 * * * *",
  "callback-connect": "*/10 * * * *",
  "seller-probe-call": "25 * * * *",
  "post-showing-call": "*/5 * * * *",
  "interview-invite-call": "*/5 * * * *",
  // Уборка осиротевших каналов моста на станции — liveVoiceScenarioTicks.ts.
  "live-voice-orphan-sweep": "*/10 * * * *",
} as const;

export type ApiProcessTickName = keyof typeof API_PROCESS_TICKS;

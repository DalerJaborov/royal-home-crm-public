/**
 * СРОКИ ЗАВЕРШЕНИЯ СЕССИИ ЖИВОГО ГОЛОСА, ОТ КОТОРЫХ ЗАВИСИТ КОНЕЦ ЗВОНКА (02.10.2026,
 * третий аудит робота, п.5).
 *
 * Итог сессии консультанта (scenarioFinish → collectInboundPart → noteConsultantSession)
 * приходит после отбоя станции, записи итога в базу (до DB_WRITE_TIMEOUT_MS) и заливки
 * записи разговора (до RECORDING_WAIT_MS) — это liveVoiceBridge.ts, endLiveVoiceSession.
 * Конец звонка на станции (incomingCalls.ts, finishIncomingCall) ждёт этот итог; ждал он
 * 20 секунд, а цепочка итога тянется до ~28: при медленной заливке итог опаздывал,
 * звонок решался «по длительности», карточка и запись разговора не ложились.
 *
 * Модуль без зависимостей, чтобы incomingCalls.ts (он намеренно не тянет за собой
 * ИИ-часть) и тесты брали числа из одного места. Что эти два числа не разошлись с
 * liveVoiceBridge.ts, держит тест live-voice-session-report-wait.test.ts: он читает
 * исходник моста и сверяет константы.
 */

/** Запись итога сессии в базу при завершении (liveVoiceBridge.ts, DB_WRITE_TIMEOUT_MS). */
export const LIVE_VOICE_DB_WRITE_TIMEOUT_MS = 8_000;
/** Ожидание заливки записи разговора перед итогом (liveVoiceBridge.ts, RECORDING_WAIT_MS). */
export const LIVE_VOICE_RECORDING_WAIT_MS = 20_000;
/** Запас на отбой станции, ожидание записи журнала и сам вызов итога. */
export const LIVE_VOICE_REPORT_MARGIN_MS = 10_000;

/** Сколько конец звонка ждёт итог сессии консультанта: вся цепочка завершения и запас. */
export const CONSULTANT_SESSION_WAIT_MS =
  LIVE_VOICE_RECORDING_WAIT_MS + LIVE_VOICE_DB_WRITE_TIMEOUT_MS + LIVE_VOICE_REPORT_MARGIN_MS;

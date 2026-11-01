import { restartAriEvents } from "./telephony/ariEvents.js";
import { syncFailoverInBackground } from "./telephony/failoverSync.js";
import { syncRoutingModeInBackground } from "./telephony/routingModeSync.js";
import { restartLiveVoiceListener } from "./telephony/liveVoiceBridge.js";
import { syncIncomingPrimaryReachabilityInBackground } from "./telephony/agentMobileFallback.js";

/**
 * ПОБОЧНЫЕ ДЕЙСТВИЯ СОХРАНЕНИЯ НАСТРОЕК — в одном месте.
 *
 * Часть настроек живёт не только в базе CRM: подписка на события АТС читает
 * креды один раз при открытии соединения, а правило «если оператор не ответил»
 * исполняет сама станция из своей внутренней базы. Записать значение в Settings
 * и на этом остановиться — значит показать «Сохранено» при поведении, которое
 * не изменилось.
 *
 * Вынесено из routes/settings.ts, потому что теперь путей сохранения два: обычный
 * PATCH и возврат к точке восстановления. Откат, не дёргающий эти же действия,
 * был бы откатом наполовину: в базе старый адрес АТС, в живом соединении — новый.
 */

/** Поля, из-за которых нужно переподключить подписку на события АТС. */
const ARI_CONNECTION_FIELDS = ["asteriskAriUrl", "asteriskAriUsername", "asteriskAriPassword"];

/** Поля живого голоса (эксперимент, пункт 5 очереди ИИ) — своя, отдельная от
 *  ARI_CONNECTION_FIELDS подписка (см. restartLiveVoiceListener), но зависит от
 *  тех же кредов ARI и от собственного тумблера/номера. */
const LIVE_VOICE_FIELDS = [
  "liveVoiceEnabled",
  // liveVoiceTestExtension здесь НЕ перечислен (02.10.2026, аудит С5/В18): мост
  // читает его на каждый StasisStart, подписку из-за него переоткрывать незачем, а
  // перезапуск рвал идущие разговоры. Сам перезапуск и сейчас не трогает живые
  // сессии — он ждёт их конца (restartLiveVoiceListener).
  "asteriskAriUrl",
  "asteriskAriUsername",
  "asteriskAriPassword",
];

/** Поля правила «если оператор не ответил» — их исполняет станция, а не CRM. */
const FAILOVER_FIELDS = [
  "incomingNoAnswerAction",
  "incomingNoAnswerSeconds",
  "incomingForwardPhone",
  "incomingNightAction",
  "incomingNightStart",
  "incomingNightEnd",
  // Куда идёт звонок в первую очередь — тоже решает станция, тем же способом
  // (значение в её базе), поэтому и уезжать должно тем же путём.
  "incomingPrimaryTarget",
  "incomingPrimaryExtension",
  // Консультант на телефоне вместо автоответчика (24.09.2026): режим, ожидание и
  // рабочие часы, вне которых он берёт сразу, — тоже значения в базе станции.
  "liveVoiceEnabled",
  "liveVoiceInboundMode",
  "workHoursStart",
  "workHoursEnd",
];

/**
 * @param touched — имена полей, которые сохранение затронуло.
 *
 * Ничего не ждёт и не бросает: настройка уже записана, а отказ станции попадает
 * в журнал внутри самих вызовов. Список входящих контекстов с 01.11.2026 —
 * константа (lib/settingsConstants.ts), перечитывать его при сохранении нечего.
 */
export function applySettingsSideEffects(touched: readonly string[]): void {
  const set = new Set(touched);
  if (ARI_CONNECTION_FIELDS.some((f) => set.has(f))) {
    restartAriEvents();
  }
  if (LIVE_VOICE_FIELDS.some((f) => set.has(f))) {
    restartLiveVoiceListener();
  }
  if (FAILOVER_FIELDS.some((f) => set.has(f))) {
    syncFailoverInBackground();
  }
  if (set.has("incomingRoutingMode")) {
    syncRoutingModeInBackground();
  }
  // Выбранный аппарат приёма обязан быть достижим — иначе звонок клиента
  // обрывается сразу (разбор 19.09.2026, см. agentMobileFallback.ts).
  if (set.has("incomingPrimaryTarget") || set.has("incomingPrimaryExtension")) {
    syncIncomingPrimaryReachabilityInBackground();
  }
}

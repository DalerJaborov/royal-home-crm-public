import { prisma } from "../db.js";
import type { CustomerTransportReference } from "./customerConversationScope.js";

/**
 * Листовой модуль без зависимостей от conversationDelivery/conversation:
 * сюда вынесено то, что нужно ОБОИМ концам бывшего цикла импортов
 * (conversationDelivery ⇄ messengers/conversation ⇄ operatorShowingDetector).
 */

/** Куда слать: диалог бота (WhatsApp/Instagram/Messenger) или Telegram. */
export type DeliveryTarget =
  | { kind: "bot"; id: string; channel: string; subscriberId: string; accountId?: string | null; transport?: CustomerTransportReference }
  | { kind: "telegram"; id: string; subscriberId: string };

/**
 * Постоянная пауза (см. OPERATOR_REPLY_PAUSE_MS в conversationDelivery.ts) держит
 * бота молчащим, только пока агент реально ведёт клиента. Если карточка ушла в
 * ClientStatus.LOST/ARCHIVED (лид признан потерянным) или в WorkStatus.INACTIVE
 * (агент клиента фактически забросил, слот активных лидов освобождён) — новое
 * обращение того же клиента не должно упираться в старую тишину: см.
 * messengers/conversation.ts, где на этот признак проверяется isPaused перед
 * тем, как решить, отвечает ли бот (уточнение владельца 18.08.2026).
 */
export async function isClientLostOrAbandoned(clientId: string): Promise<boolean> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { status: true, workStatus: true } });
  if (!client) return false;
  return client.status === "LOST" || client.status === "ARCHIVED" || client.workStatus === "INACTIVE";
}

/**
 * ОТМЕНЕНО 18.09.2026 (было: hasActiveAssignedAgent, решение 05.09.2026).
 *
 * Раньше клиент, закреплённый за агентом ПРЯМО СЕЙЧАС, гасил бота немедленно —
 * не дожидаясь, пока агент впервые напишет или позвонит. На практике это
 * убивало механику «спроси имя/доп. номер следующим ходом» (19.08.2026): приём
 * заявки назначает агента ТЕМ ЖЕ ходом (обычная очередь KPI), и ответ клиента
 * на прямой вопрос бота улетал в тишину, а не агенту, — карточка так и
 * оставалась «Покупатель ПК-000042» навсегда.
 *
 * Владелец решил обратное: бот ведёт разговор полноценно (как до приёма
 * заявки), пока агент РЕАЛЬНО не свяжется с клиентом — напишет вручную (уже
 * работает, см. `defaultPauseForSender` в conversationDelivery.ts) или
 * созвонится (`pauseConversationsAfterRealContact` там же, вызывается из
 * lib/telephony/callTracker.ts::finishCall по факту `callAttempt="TALKED"`).
 * Единственный вызов этой функции (messengers/conversation.ts::isPaused) убран
 * вместе с ней — самой функции здесь больше нет.
 */

/**
 * БАГ 19.08.2026 (скриншоты владельца — агент Ноза): статус LOST/ARCHIVED/INACTIVE у
 * карточки часто СТАРЫЙ (выставлен автоматикой или прошлым звонком задолго до
 * сегодняшнего разговора) и сам по себе не трогается, когда агент отвечает клиенту
 * вручную прямо сейчас. isClientLostOrAbandoned() выше снимал ЛЮБУЮ паузу, включая
 * только что поставленную «бессрочную» (OPERATOR_REPLY_PAUSE_MS) — бот отвечал
 * поверх агента, который в этот момент реально вёл переписку, потому что карточка
 * этого клиента ещё вчера ушла в «Неактивные»/LOST по другой причине.
 *
 * Проверку «клиент потерян/заброшен» имеет смысл применять только к ПРОТУХШЕЙ
 * паузе — старой, оставшейся с прошлого раза, когда агент вправду забросил
 * клиента. Свежепоставленная постоянная пауза (агент только что написал) — это
 * прямо противоположный сигнал: диалог ведётся здесь и сейчас, и статус карточки
 * устареть не успел. Порог взят с большим запасом относительно короткой паузы
 * (10 минут, OPERATOR_REPLY_PAUSE_MS_SHORT) и произвольных пресетов в интерфейсе
 * (часы/дни), но заведомо меньше «бессрочно» (10 лет) — так что он не мешает
 * освобождать genuinely забытые карточки: как только «бессрочная» пауза с прошлого
 * раза пролежит больше STALE_PAUSE_THRESHOLD_MS без нового вмешательства агента,
 * она перестаёт считаться «недавним касанием» и статус LOST/ARCHIVED/INACTIVE
 * снова может её снять.
 */
const STALE_PAUSE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** true, если пауза выставлена НЕ прямо сейчас, а протухла (см. STALE_PAUSE_THRESHOLD_MS
 *  выше) — только такую можно снимать статусом LOST/ARCHIVED/INACTIVE.
 *
 *  ВОЗРАСТ, А НЕ ОСТАТОК (23.09.2026, аудит №25). Считалось только по остатку
 *  срока: «бессрочная» пауза (10 лет) с прошлого года протухала бы лет через
 *  девять — потерянный клиент, написавший сам, получал тишину. Теперь пауза
 *  протухает и когда её поставили давно: botPausedAt двигается с каждым новым
 *  ответом агента (applyDeliveryPause), так что живой разговор паузу свежей
 *  держит, а заброшенный — нет. Без botPausedAt (старые записи) — по остатку. */
export function isStalePause(pausedUntil: Date | null | undefined, botPausedAt?: Date | null): boolean {
  if (!pausedUntil) return true;
  /**
   * ПАУЗУ ПОСТАВИЛИ ТОЛЬКО ЧТО — ОНА СВЕЖАЯ, КАКОЙ БЫ КОРОТКОЙ НИ БЫЛА (28.09.2026).
   *
   * Раньше пауза с остатком меньше недели считалась протухшей всегда — в том числе
   * 12-часовая от ответа директора из приложения Facebook (OPERATOR_ECHO_PAUSE_MS),
   * поставленная минуту назад. У клиента с карточкой в LOST/ARCHIVED/INACTIVE
   * статус снимал её тут же, и бот отвечал поверх директора (жалоба владельца).
   * Пауза старше суток живёт по-старому: остаток срока решает. Сутки длиннее
   * любой короткой паузы (10 минут, 12 часов), так что она доживает до конца.
   */
  if (botPausedAt && Date.now() - botPausedAt.getTime() < FRESH_PAUSE_MS) return false;
  if (pausedUntil.getTime() - Date.now() <= STALE_PAUSE_THRESHOLD_MS) return true;
  return !!botPausedAt && Date.now() - botPausedAt.getTime() > STALE_PAUSE_THRESHOLD_MS;
}

/** Пауза моложе этого — человек только что ответил сам (см. isStalePause). */
const FRESH_PAUSE_MS = 24 * 60 * 60 * 1000;

/**
 * КОНЕЧНЫЙ СРОК ПАУЗЫ ПОСЛЕ ОТВЕТА ОПЕРАТОРА (аудит ботов 10.10.2026, P0-3) —
 * ЗАГОТОВЛЕНО, НО ВЫКЛЮЧЕНО: включение — решение владельца, отдельным шагом.
 *
 * Сейчас ответ своего агента ставит паузу на 10 лет (OPERATOR_REPLY_PAUSE_MS,
 * решение 18.08.2026), и снимает её только кнопка, статус LOST/INACTIVE или
 * сторож пауз (lib/botPauseWatch.ts, на проде выключен). На 10.10: 132 диалога
 * на такой паузе, в 35 последним писал клиент, 29 из них ждут больше 72 ч.
 *
 * Политика: пауза перестаёт держать бота через `hours` после ПОСЛЕДНЕГО ответа
 * оператора. Мерило — botPausedAt: applyDeliveryPause двигает его с каждым новым
 * ручным ответом (пока агент пишет, пауза свежая), а заброшенный разговор
 * отпускается сам. Строка паузы в базе не трогается — бот просто снова отвечает
 * на следующее сообщение клиента (снять её в базе — работа сторожа пауз).
 *
 * Включить: `enabled: true` здесь (или вынести в Настройки, если владелец захочет
 * переключать сам). Выключено — поведение побайтово прежнее.
 */
export interface OperatorPausePolicy {
  enabled: boolean;
  hours: number;
}

export const OPERATOR_PAUSE_POLICY: OperatorPausePolicy = { enabled: false, hours: 48 };

/** true — по политике пауза оператора уже истекла (чистая функция, проверяется тестом). */
export function operatorPauseExpired(
  botPausedAt: Date | null | undefined,
  policy: OperatorPausePolicy = OPERATOR_PAUSE_POLICY,
  now: number = Date.now()
): boolean {
  if (!policy.enabled || !botPausedAt || policy.hours <= 0) return false;
  return now - botPausedAt.getTime() >= policy.hours * 60 * 60 * 1000;
}

/**
 * ФОРМУЛА ПАУЗЫ ОПЕРАТОРА — ОДНА НА TELEGRAM И КАНАЛЫ META (ночная проверка
 * 24.09.2026, находка №114). Раньше жила только веткой на месте вызова в
 * messengers/conversation.ts (isPaused = pausedInDb && !(stale && lost)):
 * «бессрочная» пауза там протухает через STALE_PAUSE_THRESHOLD_MS и снимается
 * статусом LOST/ARCHIVED/workStatus INACTIVE. Telegram (telegram/bot.ts)
 * проверял голый `pausedUntil > now()` — ни статус, ни возраст паузы её не
 * снимали, бот молчал навсегда. Возвращает true, если бот должен молчать
 * (пауза ещё действует).
 */
export async function isOperatorPauseActive(
  pausedUntil: Date | null | undefined,
  botPausedAt: Date | null | undefined,
  clientId: string | null | undefined,
  policy: OperatorPausePolicy = OPERATOR_PAUSE_POLICY
): Promise<boolean> {
  const pausedInDb = !!pausedUntil && pausedUntil.getTime() > Date.now();
  if (!pausedInDb) return false;
  if (operatorPauseExpired(botPausedAt, policy)) return false;
  if (clientId && isStalePause(pausedUntil, botPausedAt) && (await isClientLostOrAbandoned(clientId))) {
    return false;
  }
  return true;
}

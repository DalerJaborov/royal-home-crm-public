import { prisma } from "../../db.js";
import { findAgentsWithPermission } from "../recipients.js";
import { dushanbeTimeString } from "../dushanbeTime.js";

/**
 * Настройки приёма входящих звонков — одно место, где они читаются.
 *
 * РОЛИ ОПЕРАТОРА ВХОДЯЩИХ БОЛЬШЕ НЕТ (решение владельца 18.08.2026): список
 * «Кто принимает входящие» удалён вместе с рабочим местом оператора и браузерной
 * трубкой. Звонки распределяет станция, разговор разбирает сама CRM по расшифровке
 * (см. autoLeadFromCall.ts).
 *
 * ПЕРВАЯ ЛИНИЯ ВЕРНУЛАСЬ ПРИЗНАКОМ, А НЕ РОЛЬЮ (владелец 20.09.2026): уведомления и
 * запасное авторство записи получают сотрудники с `Agent.takesUnknownCalls` — те, кто
 * физически снимает трубку на незнакомых номерах, — а не все обладатели права
 * clients.assign, как было до 20.09. См. incomingOperatorIds() в конце файла.
 *
 * Остальные настройки к роли отношения не имели и остаются: часы приёма, ночной
 * режим, автосоздание карточки, перевод звонка на ответственного агента.
 */

export interface IncomingSettings {
  autoCreateClient: boolean;
  /** Тип карточки, заводимой звонком до квалификации. */
  defaultKind: "OTHER" | "BUYER" | "SELLER";
  assignOnQualify: boolean;
  /** Номер, куда АТС уводит звонок при недоступном операторе. CRM только показывает. */
  forwardPhone: string | null;
  panelEnabled: boolean;
  /** Слать уведомление на телефон о самом звонке. */
  pushEnabled: boolean;
  /** Ограничивать часы, в которые CRM беспокоит людей звонками. */
  hoursEnabled: boolean;
  /** "HH:MM" по Душанбе. Действуют только при hoursEnabled. */
  hoursStart: string;
  hoursEnd: string;
  /**
   * Звонок известного клиента сначала уходит ЕГО агенту, и только потом в общую
   * очередь (решение владельца 16.08.2026). Выключено по умолчанию: возможность
   * трогает живую телефонию, и включать её должен человек, а не выкат.
   */
  routeToAssignedAgent: boolean;
  /** Сколько секунд станция звонит агенту своего клиента, прежде чем уйти на
   *  голосовую почту. 0 — без ограничения (владелец 20.08.2026): диалплан на
   *  станции передаёт Dial() пустой таймаут, звонит, пока клиент сам не положит
   *  трубку.
   *
   *  НЕ ЗАВИСИТ ОТ РЕЖИМА КОНСУЛЬТАНТА (владелец 11.10.2026: «робот НЕ отвечает
   *  клиентам агента»). С 02.10 по 11.10 при включённом консультанте агенту звонили
   *  не дольше liveVoiceInboundWaitSeconds (поле knownClientRingSeconds), чтобы
   *  звонок успел дойти до робота; робота у клиентов агента больше нет — и
   *  укорачивать гудки агенту незачем. */
  routeRingSeconds: number;
  /**
   * Заготовка на будущий способ маршрутизации незнакомых звонков — см.
   * комментарий у Settings.incomingRoutingMode в schema.prisma. Значение
   * синхронизируется в AstDB (lib/telephony/routingModeSync.ts), но реально на
   * линии сейчас работает только "assigned_then_forward": диалплана,
   * читающего остальные варианты, на станции ещё нет.
   */
  routingMode: string;
  /** Кто дежурит по очереди при `routingMode === "dedicated_operator"` — см.
   *  Settings.incomingDutyAgentIds в schema.prisma. Порядок = порядок ротации. */
  dutyAgentIds: string[];
  /**
   * Куда станция ведёт входящий в первую очередь: "queue" — операторам, как было,
   * "extension" — прямо на аппарат primaryExtension, и операторы не звонят вовсе.
   * Это НЕ routingMode выше: тот про выбор получателя среди сотрудников, а этот —
   * про то, звонит ли очередь вообще (решение владельца 21.08.2026).
   * Показывается на дашборде телефонии: режим, о котором никто не знает, — это
   * ровно тот случай, когда звонки «пропадают» без объяснений.
   */
  primaryTarget: "queue" | "extension";
  primaryExtension: string | null;
}

const FALLBACK: IncomingSettings = {
  autoCreateClient: true,
  defaultKind: "OTHER",
  assignOnQualify: true,
  forwardPhone: null,
  panelEnabled: true,
  pushEnabled: true,
  hoursEnabled: false,
  hoursStart: "09:00",
  hoursEnd: "21:00",
  routeToAssignedAgent: false,
  routeRingSeconds: 150,
  routingMode: "assigned_then_forward",
  dutyAgentIds: [],
  primaryTarget: "queue",
  primaryExtension: null,
};

export async function loadIncomingSettings(): Promise<IncomingSettings> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      incomingAutoCreateClient: true,
      incomingDefaultKind: true,
      incomingAssignOnQualify: true,
      incomingForwardPhone: true,
      incomingPanelEnabled: true,
      incomingPushEnabled: true,
      incomingHoursEnabled: true,
      incomingHoursStart: true,
      incomingHoursEnd: true,
      incomingRouteToAssignedAgent: true,
      incomingRouteRingSeconds: true,
      incomingRoutingMode: true,
      incomingDutyAgentIds: true,
      incomingPrimaryTarget: true,
      incomingPrimaryExtension: true,
    },
  });
  if (!settings) return FALLBACK;

  // 0 теперь ЗНАЧИМОЕ значение — «без ограничения» (владелец 20.08.2026).
  // Отрицательное в колонке (правка руками, откат миграции) означало бы
  // «звонить агенту минус секунд», то есть перевод в никуда: берём умолчание.
  const routeRingSeconds = settings.incomingRouteRingSeconds >= 0 ? settings.incomingRouteRingSeconds : 150;

  return {
    autoCreateClient: settings.incomingAutoCreateClient,
    /**
     * ВСЕГДА «ПРОЧЕЕ» — НЕЗАВИСИМО ОТ ТОГО, ЧТО ЛЕЖИТ В НАСТРОЙКЕ (разбор 30.08.2026).
     *
     * Настройка позволяла выставить BUYER или SELLER, и при таком значении КАЖДЫЙ
     * отвеченный звонок и каждое сообщение автоответчика становилось карточкой
     * покупателя — то есть лидом в раздаче агентам ещё до всякой квалификации.
     * Мина: один переключатель в Настройках, поставленный из любопытства, ломал
     * весь разбор входящих, который в остальном сделан правильно (непринятый
     * звонок карточку не создаёт, короткая расшифровка агента не получает,
     * IRRELEVANT снимает карточку — см. lib/telephony/incomingCalls.ts).
     *
     * Возможность убрана и из схемы настроек (routes/settings.ts), но чтение
     * поправлено ОТДЕЛЬНО и намеренно: в базе на проде уже могло лежать «BUYER»,
     * и валидация нового значения такую запись не исправляет. Тип карточки звонку
     * назначает квалификация разговора, а не переключатель.
     */
    defaultKind: "OTHER",
    assignOnQualify: settings.incomingAssignOnQualify,
    forwardPhone: settings.incomingForwardPhone,
    panelEnabled: settings.incomingPanelEnabled,
    pushEnabled: settings.incomingPushEnabled,
    hoursEnabled: settings.incomingHoursEnabled,
    hoursStart: settings.incomingHoursStart,
    hoursEnd: settings.incomingHoursEnd,
    routeToAssignedAgent: settings.incomingRouteToAssignedAgent,
    routeRingSeconds,
    routingMode: settings.incomingRoutingMode || "assigned_then_forward",
    dutyAgentIds: settings.incomingDutyAgentIds,
    // Режим без номера аппарата станция считает обычной очередью (см. failoverSync):
    // дашборд обязан показывать то же самое, иначе он врёт ровно в том случае,
    // ради которого его и открывают.
    primaryTarget:
      settings.incomingPrimaryTarget === "extension" && (settings.incomingPrimaryExtension ?? "").trim()
        ? "extension"
        : "queue",
    primaryExtension: settings.incomingPrimaryExtension,
  };
}

/**
 * Можно ли сейчас беспокоить оператора звонком.
 *
 * ВЛИЯЕТ ТОЛЬКО НА УВЕДОМЛЕНИЯ, а не на журнал. Звонок, пришедший ночью, всё равно
 * записывается, карточка по нему заводится, и оператор увидит его утром в журнале —
 * иначе настройка «часы приёма» означала бы «ночные обращения не существуют», и
 * агентство теряло бы клиентов ровно там, где считает, что ничего не происходит.
 *
 * Окно оператора при этом не прячем: если человек всё-таки снял трубку в полночь,
 * он говорит с живым клиентом, и записать услышанное ему нужно тем более.
 *
 * Окно через полночь (22:00–02:00) поддержано намеренно: у дежурного оператора
 * смена именно такая, а сравнение «начало < конца» отдало бы ему пустой интервал.
 */
export function incomingHoursOpen(settings: IncomingSettings, at: Date = new Date()): boolean {
  if (!settings.hoursEnabled) return true;
  const { hoursStart: start, hoursEnd: end } = settings;
  // Одинаковые границы — это «круглосуточно», а не «нисколько»: пустая смена
  // означала бы, что оператор не получит ни одного уведомления никогда, и понять
  // это по двум одинаковым полям в Настройках человек не может.
  if (start === end) return true;
  const now = dushanbeTimeString(at);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Кому уходят уведомления о входящем и кто становится ЗАПАСНЫМ автором записи о
 * разговоре, если снявшего трубку опознать не удалось.
 *
 * ПЕРВАЯ ЛИНИЯ, А НЕ РУКОВОДСТВО (решение владельца 20.09.2026). Раньше это был
 * список обладателей права `clients.assign`, то есть руководителей, и директор
 * получал уведомление о каждом звонке, которого сам не принимает: «шлют пуши, но
 * не звонки». Уведомление о том, что телефон звонит СЕЙЧАС, имеет смысл только
 * для того, кто эту трубку и снимает, — для сотрудников с признаком
 * `takesUnknownCalls` (см. schema.prisma, model Agent).
 *
 * Запасной путь на `clients.assign` оставлен НАРОЧНО и только на случай, когда
 * оператор не назначен ни один: иначе звонок незнакомого номера не увидел бы вовсе
 * никто, и мы поменяли бы лишнее уведомление на потерянного клиента. Та же защита
 * стоит в lib/telephony/agentIncomingReadiness.ts — она там по той же причине.
 *
 * Имя функции сохранено намеренно — по нему её зовут приём звонка и автоответчик,
 * а переименование ради вкуса стоило бы правок в чужих файлах.
 *
 * Предела выборке здесь не ставим сознательно: это список сотрудников агентства с
 * одним признаком, он измеряется единицами, а урезать его значило бы молча не
 * уведомить кого-то из дежурных.
 */
export async function incomingOperatorIds(_settings?: IncomingSettings): Promise<string[]> {
  const firstLine = await prisma.agent.findMany({
    where: { takesUnknownCalls: true, isActive: true, frozenAt: null },
    select: { id: true },
  });
  if (firstLine.length > 0) return firstLine.map((a) => a.id);
  return findAgentsWithPermission("clients.assign");
}

/**
 * Напоминания о встречах и задачах агента.
 *
 * Две разные штуки, и обе нужны:
 *  1. Вечерняя сводка (18:00 накануне) — одним push весь завтрашний день, чтобы
 *     агент успел спланировать вечером, а не узнавал о показе утром.
 *  2. «Через час» — точечный push перед конкретной встречей.
 *
 * Время в задаче необязательно: «перезвонить в четверг» — законная задача без часа.
 * Такие попадают только в вечернюю сводку; напоминать «за час» тут не от чего
 * отсчитывать. Признак «время не указано» — полночь UTC: именно её даёт поле даты
 * без времени (см. AddInteractionModal), а осмысленных встреч в 05:00 по Душанбе
 * не бывает.
 *
 * ⚠️ Записей «дата без часа» на самом деле ДВЕ, и hasExactTime знает только первую.
 * Вторая — полночь ПО ДУШАНБЕ (её подставляет фронтенд, см. hasRealShowingHour
 * ниже). Для внутренних напоминаний агенту разница неважна, а вот клиенту нельзя
 * писать «показ в 00:00» — этим и занимается hasRealShowingHour.
 */

import { prisma } from "../db.js";
import { reportCronRowError } from "./cronHeartbeat.js";
import { sendPushToAgent, sendPushToAgents, closeLeadPushNotifications } from "../push.js";
import { notifyFeedOnly } from "./notifications.js";
import {
  DUSHANBE_OFFSET_MS,
  dushanbeDayRange,
  dushanbeStartOfToday,
  dushanbeWallClock,
  isWithinDushanbeWindow,
} from "./dushanbeTime.js";
import { formatClientName, type ClientKind } from "@royal-home/shared";
import { TASK_WHERE } from "./tasks.js";
import { findAgentsWithPermission } from "./recipients.js";
import { deliverToConversation, findClientDeliveryTargets } from "./conversationDelivery.js";
import { CONFIRM_ASK_STAGE, CONFIRM_NUDGE_STAGE } from "./showingConfirmation.js";
// Имя из карточки годится для обращения далеко не всегда: у клиента из Instagram
// там лежит ник. Правило одно на весь проект — см. ai/replyGuards.ts.
import { looksLikeRealName } from "../ai/replyGuards.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "./scoreJournal.js";
import { isWithinWorkingHours, isWithinAlarmHours } from "./workingHours.js";

/** Задача заведена с конкретным временем, а не просто «на этот день». */
export function hasExactTime(date: Date): boolean {
  return !(date.getUTCHours() === 0 && date.getUTCMinutes() === 0);
}

/** "HH:MM" по Душанбе — для текста напоминания. */
function timeLabel(date: Date): string {
  const wall = new Date(date.getTime() + DUSHANBE_OFFSET_MS);
  return `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Строка задачи в вечерней сводке. Имя клиента — ВСЕГДА с ролью впереди
 * («Покупатель Далер», см. formatClientName): в сводке подряд идут чужие карточки,
 * и без роли агент не понимает, к кому едет — к тому, кто покупает, или к тому,
 * чью квартиру принимаем.
 */
function taskLine(task: {
  nextAction: string | null;
  nextActionDate: Date | null;
  client: { fullName: string; kind: ClientKind };
}): string {
  const time = task.nextActionDate && hasExactTime(task.nextActionDate) ? `${timeLabel(task.nextActionDate)} — ` : "";
  return `${time}${formatClientName(task.client)}: ${task.nextAction ?? "задача"}`;
}

/**
 * Вечерняя сводка: каждому агенту — его задачи на завтра одним сообщением.
 * Возвращает, скольким агентам ушло, для журнала крона.
 */
export async function sendTomorrowDigest(now: Date = new Date()): Promise<number> {
  const startOfTomorrow = new Date(dushanbeStartOfToday(now).getTime() + 24 * 60 * 60 * 1000);
  const endOfTomorrow = new Date(startOfTomorrow.getTime() + 24 * 60 * 60 * 1000);

  const tasks = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      completedAt: null,
      nextActionDate: { gte: startOfTomorrow, lt: endOfTomorrow },
    },
    orderBy: { nextActionDate: "asc" },
    select: {
      agentId: true,
      subjectAgentId: true,
      nextAction: true,
      nextActionDate: true,
      client: { select: { fullName: true, kind: true } },
    },
  });
  if (tasks.length === 0) return 0;

  // Адресат задачи — subjectAgentId, если он есть (SYSTEM/AI-запись, П-10),
  // иначе agentId (обычная задача живого агента).
  const byAgent = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const owner = task.subjectAgentId ?? task.agentId;
    if (!owner) continue;
    const list = byAgent.get(owner);
    if (list) list.push(task);
    else byAgent.set(owner, [task]);
  }

  let sent = 0;
  for (const [agentId, agentTasks] of byAgent) {
    // Больше трёх строк в push всё равно не покажет ни одна система уведомлений —
    // остальное сворачиваем в счётчик, подробности агент увидит в календаре.
    const shown = agentTasks.slice(0, 3).map(taskLine);
    const rest = agentTasks.length - shown.length;
    const body = rest > 0 ? `${shown.join("\n")}\n…и ещё ${rest}` : shown.join("\n");

    await sendPushToAgent(agentId, {
      kind: "task",
      title: `🔔 Завтра у вас ${agentTasks.length} ${plural(agentTasks.length, "задача", "задачи", "задач")}`,
      body,
      url: "/calendar",
      tag: "tomorrow-digest",
    });
    sent++;
  }
  return sent;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Джоб тикает каждые 5 минут, окно шире тика — иначе встреча, попавшая между
 * тиками, осталась бы без напоминания. */
const WINDOW_MS = 10 * 60 * 1000;

/**
 * Ступени напоминаний.
 *
 * У ПОКАЗА покупателя (тип SHOWING) — три: за день (спланировать), за 2 часа
 * (успеть собраться и выехать) и за 40 минут — решение владельца 03.08.2026:
 * письменная спецификация требовала «день + час», но 30.07 владелец отдельно
 * попросил ступени под пробки («у нас пробки хуёвые»); 03.08 решил объединить
 * оба требования, а не выбирать одно.
 *
 * У ВСТРЕЧИ с собственником (тип MEETING) — по письменной спецификации: если
 * встреча «завтра» — 2 часа и 40 минут (тот же трафик), если дальше — день и час.
 *
 * У прочих задач («перезвонить в четверг в 15:00») ступень одна — за час, как было.
 */
const REMINDER_STAGES: { key: string; leadMs: number; label: string }[] = [
  { key: "1d", leadMs: 24 * 60 * 60 * 1000, label: "Завтра" },
  { key: "2h", leadMs: 2 * 60 * 60 * 1000, label: "Через 2 часа" },
  { key: "1h", leadMs: 60 * 60 * 1000, label: "Через час" },
  { key: "40m", leadMs: 40 * 60 * 1000, label: "Через 40 минут" },
  /**
   * ПЕРЕЗВОН ПОСЛЕ НЕДОЗВОНА — ступень «в срок», а не «заранее». leadMs = 0.
   *
   * Было `leadMs: 15 минут`, и это схлопывалось само на себя: перезвон
   * назначается ровно через `noAnswerRetryMinutes` (по умолчанию те же 15) после
   * неудачного звонка — значит «за 15 минут до» наступало в ту же секунду, когда
   * агент положил трубку. Он получал «Пора перезвонить» немедленно, а когда
   * действительно приходило время звонить, не получал НИЧЕГО.
   *
   * Ошибка не всплывала, потому что уведомление приходило — просто не тогда.
   * Найдено 14.08.2026, когда владелец попросил «чтобы через 15 минут напомнило».
   */
  { key: "due", leadMs: 0, label: "Пора перезвонить" },
];


/**
 * Какие ступени положены записи.
 *
 * «Не ответил» — особый случай (решение владельца 30.07): CRM напоминает перезвонить
 * через 15 минут, и ступень тут одна. Ключ по ИСХОДУ, а не по типу: перезвон живёт
 * в той же записи разговора, где стоит NO_ANSWER, — отдельная задача не заводится.
 */
/**
 * ОДНА СТУПЕНЬ НА ОДНУ ВСТРЕЧУ (владелец 20.09.2026: «повторы вообще убери всем,
 * пусть одного раза достаточно»).
 *
 * До этой правки показ давал агенту ТРИ уведомления об одном и том же событии
 * (за день, за 2 часа, за 40 минут), а встреча — два. С точки зрения агента это
 * один повод, повторённый трижды, и именно такие цепочки владелец назвал
 * надоедливыми.
 *
 * ОСТАВЛЕНА ИМЕННО «ЗА 2 ЧАСА», а не «за 40 минут»: за два часа ещё можно
 * что-то сделать — подтвердить с клиентом, доехать, перенести. За сорок минут
 * поменять уже ничего нельзя, и уведомление превращается в констатацию.
 * Планирование накануне закрывает ежедневная сводка «Завтра у вас N задач»
 * (notifyTomorrowDigest в этом же файле) — отдельная ступень «за день» её
 * дублировала.
 *
 * Прежнее обоснование трёх ступеней (12.08.2026, развилка «близко/далеко» по
 * порогу в 36 часов от момента постановки задачи) снято этим решением: развилка
 * отличала только НАБОР ступеней, а набор теперь один на все случаи, поэтому и
 * сам порог удалён.
 *
 * «Не ответил» — особый случай (решение владельца 30.07): перезвон через 15
 * минут, ступень тут и раньше была одна.
 */
const stagesFor = (type: string, outcome: string | null): string[] => {
  if (outcome === "NO_ANSWER") return ["due"];
  if (type === "SHOWING" || type === "MEETING") return ["2h"];
  return ["1h"];
};

/**
 * Кому, кроме самого агента, дублировать напоминания о показах.
 *
 * Настройка `pushShowingsToSupervisors` появилась 11.08.2026: владелец назвал
 * напоминания о показе нужными, хотя они работают с 03.08 — потому что уходили
 * ТОЛЬКО агенту показа, а руководитель показы не ведёт и не получал ни одного.
 * Выключается там же в Настройках, если поток окажется избыточным.
 */
/**
 * Задачу закрыли (PATCH /interactions/:id/complete) — гасим у наблюдателей и
 * руководителей все её пуши, которые могли повиснуть: «показ через N» (все
 * ступени сразу, ступень заранее неизвестна — закрываем каждую, лишнее закрытие
 * несуществующего уведомления безопасно), «показ не отмечен», «просрочено».
 * Без этого руководитель видел напоминание о показе, который агент уже отметил
 * состоявшимся десять минут назад.
 */
export async function closeMeetingReminderPushes(taskId: string, agentId: string): Promise<void> {
  const watchers = await loadShowingWatchers();
  // Руководителям «просрочено»/«показ не отмечен» уходит ОДНИМ пушем на весь
  // тик со списком из нескольких задач сразу (sourceId — время тика, не задачи,
  // см. notifyMissedShowings/notifyOverdueTasks) — закрыть его по одной
  // завершённой задаче нельзя, не спрятав ещё не закрытые соседние. Реально
  // адресный, «свой» тег есть только у пуша САМОМУ агенту (`-agent`), его и
  // закрываем — до 20.08.2026 здесь ошибочно пытались погасить
  // `no-show-${taskId}`/`overdue-${taskId}` у руководителей: тег, который
  // никогда не отправляется (руководителям уходит `*-batch-<время тика>`), так
  // что оба вызова были немым no-op.
  await closeLeadPushNotifications([
    ...watchers.flatMap((id) =>
      REMINDER_STAGES.map((s) => ({ agentId: id, tag: `meeting-watch-${taskId}-${s.key}` }))
    ),
    { agentId, tag: `no-show-${taskId}-agent` },
    { agentId, tag: `overdue-${taskId}-agent` },
  ]);
}

async function loadShowingWatchers(): Promise<string[]> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { pushShowingsToSupervisors: true },
  });
  if (s && !s.pushShowingsToSupervisors) return [];
  return findAgentsWithPermission("clients.assign");
}

/**
 * Точечные напоминания перед встречей/показом по ступеням выше.
 * Только задачи с указанным временем — см. шапку файла.
 */
export async function sendHourBeforeReminders(now: Date = new Date()): Promise<number> {
  // Получатели дублей считаются не больше одного раза за тик и только если
  // дублировать реально есть что: тик раз в пять минут обычно пустой.
  let watchers: string[] | null = null;
  const showingWatchers = async () => (watchers ??= await loadShowingWatchers());

  // Одна выборка на все ступени: берём задачи в самом широком окне (от ближайшей
  // ступени до дальней), дальше каждую сверяем со своей ступенью.
  const maxLead = Math.max(...REMINDER_STAGES.map((s) => s.leadMs));
  const minLead = Math.min(...REMINDER_STAGES.map((s) => s.leadMs));
  const from = new Date(now.getTime() + minLead - WINDOW_MS);
  const to = new Date(now.getTime() + maxLead + WINDOW_MS);

  const tasks = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      completedAt: null,
      nextActionDate: { gte: from, lte: to },
      // Решение владельца 02.10.2026: «⏰ Через час» — только о том, что агент
      // поставил себе сам. Автозадачи системы (actorKind SYSTEM или заведённые
      // генератором с autoTaskKind, lib/autoTasks.ts — например «Добавьте объект
      // по заявке ПР-…» из dealStalePipeline) напоминания не получают.
      actorKind: { not: "SYSTEM" },
      autoTaskKind: null,
    },
    select: {
      id: true,
      type: true,
      outcome: true,
      agentId: true,
      subjectAgentId: true,
      nextAction: true,
      nextActionDate: true,
      createdAt: true,
      remindersSent: true,
      confirmAskedAt: true,
      confirmedAt: true,
      declinedAt: true,
      agent: { select: { fullName: true } },
      subjectAgent: { select: { fullName: true } },
      client: { select: { fullName: true, kind: true, phone: true, shortId: true } },
    },
  });

  let sent = 0;
  for (const task of tasks) {
    try {
      // Адресат напоминания и подпись — subjectAgentId, если запись сделана не
      // агентом (SYSTEM/AI, П-10), иначе обычный agentId.
      const ownerId = task.subjectAgentId ?? task.agentId;
      const ownerName = task.subjectAgent?.fullName ?? task.agent?.fullName ?? "агента";
      if (!ownerId) continue;
      const nextActionDate = task.nextActionDate;
      if (!nextActionDate || !hasExactTime(nextActionDate)) continue;

      // Ступень этой задачи, чьё окно накрывает текущий момент и которая ещё не ушла.
      const msLeft = nextActionDate.getTime() - now.getTime();
      const stage = REMINDER_STAGES.find(
        (s) =>
          stagesFor(task.type, task.outcome).includes(s.key) &&
          !task.remindersSent.includes(s.key) &&
          Math.abs(msLeft - s.leadMs) <= WINDOW_MS
      );
      if (!stage) continue;

      // Отметка ставится БЕЗ ОГЛЯДКИ на успех push-доставки (переигран 20.08.2026 —
      // живой инцидент: агент без работающей подписки получал такой же по форме
      // пуш «Карточка не заполнена» каждые 5 минут бесконечно, потому что отметка
      // ждала delivered>0). sendPushToAgent пишет уведомление в ленту ВСЕГДА
      // (createNotification внутри неё безусловна), и tag `meeting-<id>` заменяет
      // предыдущий БРАУЗЕРНЫЙ баннер, но не строку в ленте — без своей отметки эта
      // задача оставалась бы кандидатом и плодила бы дубли в ленте у любого агента
      // без активной push-подписки, а не только у того, кому реально не повезло с
      // разовым сбоем сети. Тот же приём, что и в notifyOverdueMaterials/
      // notifyOverdueSummaries — они уже не оглядывались на push.
      // Состояние подтверждения дописываем в ТОТ ЖЕ push, а не шлём отдельный:
      // агенту важно узнать «показ через 2 часа» и «клиент молчит» одним взглядом,
      // а два уведомления об одном показе подряд читают как одно.
      const confirmation = confirmationNote(task);

      await sendPushToAgent(ownerId, {
        kind: task.type === "SHOWING" ? "showing" : "task",
        title: `⏰ ${stage.label}: ${task.nextAction}`,
        body: `${formatClientName(task.client)} · ${task.client.phone ?? "телефон не указан"} — в ${timeLabel(nextActionDate)}${confirmation}`,
        url: `/clients/${task.client.shortId}`,
        // Тег со ступенью: иначе напоминание «за 40 минут» заменило бы собой
        // «за 2 часа» в шторке — агент увидел бы одно уведомление вместо двух.
        tag: `meeting-${task.id}-${stage.key}`,
      });

      // ТО ЖЕ САМОЕ РУКОВОДСТВУ, если включено в Настройках. Напоминания о показах
      // работают с 03.08.2026, но уходят ТОЛЬКО агенту показа — а владелец 11.08.2026
      // назвал их нужными, потому что сам показы не ведёт и не получал ни одного.
      // Отдельная выборка получателей делается один раз на тик (см. supervisors ниже),
      // а не на каждый показ.
      if (task.type === "SHOWING") {
        const watchers = await showingWatchers();
        const others = watchers.filter((id) => id !== ownerId);
        if (others.length > 0) {
          void sendPushToAgents(others, {
            kind: "showing",
            title: `⏰ ${stage.label}: показ у ${ownerName}`,
            body: `${formatClientName(task.client)} — в ${timeLabel(nextActionDate)}${confirmation}`,
            url: `/clients/${task.client.shortId}`,
            tag: `meeting-watch-${task.id}-${stage.key}`,
          }).catch(() => {});
        }
      }

      await prisma.interaction.update({
        where: { id: task.id },
        data: { remindersSent: { push: stage.key }, reminderSentAt: new Date() },
      });
      sent++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Напоминание за час до встречи", task.id, err);
    }
  }
  return sent;
}

/* ─────────────────────── Подтверждение показа обеими сторонами ───────────────
 *
 * Постановка владельца 31.07: «перед показом написать автоматически человеку,
 * что у него назначен показ, за несколько часов, в рабочее дневное время, чтобы
 * он не забыл; и агенту, чтобы агент не забыл. И у обоих можно подтверждение
 * брать, что реально состоится показ?»
 *
 * Правило, от которого нельзя отступать: МОЛЧАНИЕ КЛИЕНТА — НЕ ОТКАЗ. Половина
 * людей не отвечает на такие сообщения, а на показ приходит; автоматическая
 * отмена по тишине потеряла бы живых клиентов. Не подтвердил — это не отмена, а
 * повод агенту позвонить ЗАРАНЕЕ, до того как он зря поехал.
 *
 * Формулировка тоже часть требования: просим «подтвердите, что придёте», а не
 * «вы не передумали?» — второе само подсказывает передумать.
 * ───────────────────────────────────────────────────────────────────────────── */

/** За сколько до показа просим подтвердить. Четыре часа — компромисс: раньше
 *  человек забудет ещё раз, позже агент уже не успеет перестроить день. */
const CONFIRM_LEAD_MS = 4 * 60 * 60 * 1000;

/** Ближе этого просить бессмысленно: агент уже собирается или едет. */
const CONFIRM_MIN_LEAD_MS = 45 * 60 * 1000;

/** Дальше этого горизонта показ ещё не «завтрашний» — не тревожим заранее. */
const CONFIRM_HORIZON_MS = 36 * 60 * 60 * 1000;

/** Когда вообще допустимо писать КЛИЕНТУ. Сообщение в 05 утра раздражает сильнее,
 *  чем помогает, и в мессенджерах читается как спам. */
const CLIENT_DAY_START = "09:00";
const CLIENT_DAY_END = "20:00";
const CLIENT_DAY_START_HOUR = 9;
const CLIENT_DAY_END_HOUR = 20;

/** Час, в который спрашиваем накануне, если «за 4 часа» приходится на ночь. */
const EVENING_ASK_HOUR = 19;

/** За сколько до показа агенту уходит сигнал «клиент не подтвердил». Три часа:
 *  раньше первого напоминания о самом показе (2 часа) — чтобы звонок случился
 *  до сборов, а не вдогонку. */
const UNCONFIRMED_LEAD_MS = 3 * 60 * 60 * 1000;

/** Сколько ждём ответа, прежде чем считать, что клиент молчит. Без этой паузы
 *  сигнал «не подтвердил» мог уйти в ту же минуту, что и просьба подтвердить. */
const MIN_ANSWER_MS = 45 * 60 * 1000;

/** Окно для push СОТРУДНИКУ шире клиентского: агент работает с раннего утра, и
 *  показ в 09:00 обязан дать ему шанс позвонить до выезда. */
const AGENT_DAY_START = "08:00";
const AGENT_DAY_END = "22:00";

/**
 * Когда положено спросить клиента про показ в `showingAt`.
 *
 * Обычный случай — за 4 часа. Но ранний показ (в 08:00–09:00) даёт «за 4 часа» =
 * 04:00–05:00 утра, а ночью писать нельзя. Такие переносим НЕ вперёд, на утро
 * того же дня (в 09:00 просить о показе в 09:00 уже поздно), а НАЗАД — на 19:00
 * накануне: вечер человек проводит с телефоном и планирует завтрашний день, и у
 * агента остаётся целая ночь и утро на реакцию.
 *
 * Экспортируется ради теста: правило про ранние показы — самая хрупкая часть.
 */
export function confirmationDueAt(showingAt: Date): Date {
  const ideal = new Date(showingAt.getTime() - CONFIRM_LEAD_MS);
  const idealHour = dushanbeWallClock(ideal).getUTCHours();
  if (idealHour >= CLIENT_DAY_START_HOUR && idealHour < CLIENT_DAY_END_HOUR) return ideal;

  // Накануне в 19:00 по Душанбе. Считаем от «настенной» даты показа и вычитаем
  // сдвиг обратно — setHours взял бы пояс процесса (в контейнере UTC).
  const wall = dushanbeWallClock(showingAt);
  return new Date(
    Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - 1, EVENING_ASK_HOUR, 0, 0) -
      DUSHANBE_OFFSET_MS
  );
}

/**
 * ЧАС ПОКАЗА НАСТОЯЩИЙ, А НЕ ПОДСТАВЛЕННЫЙ ПО УМОЛЧАНИЮ.
 *
 * Разбор живых переписок 22.08.2026: клиент получил «у вас показ завтра в 00:00».
 * Часовой пояс тут ни при чём — timeLabel честно перевёл момент в местные часы, и
 * ровно 00:00 по Душанбе в базе и лежало (19:00 UTC накануне). Это ВТОРАЯ запись
 * «даты без часа», которой шапка этого файла не знала: голая дата ложится полночью
 * UTC (её и отсекает hasExactTime), а фронтенд отдаёт время через
 * `dushanbeInputToIso(date, time)`, и тот при пустом времени подставляет "00:00"
 * ПО ДУШАНБЕ (apps/web/src/lib/date.ts) — для hasExactTime это «точный час».
 *
 * Полночь показом быть не может: даже бот вправе назначать показы только с 09:00
 * до 20:00 (lib/showingBooking.ts, SHOWING_HOURS_START/LAST). Поэтому час пишем
 * клиенту, только если он настоящий; «завтра» без часа честнее приглашения на
 * полночь. Сам показ при этом остаётся и подтверждения по нему мы всё равно
 * просим: время у агента в карточке, а у клиента — вопрос, который он задаст.
 */
function hasRealShowingHour(date: Date): boolean {
  if (!hasExactTime(date)) return false;
  const wall = dushanbeWallClock(date);
  return !(wall.getUTCHours() === 0 && wall.getUTCMinutes() === 0);
}

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** «23 августа» по календарю Душанбе — на случай показа дальше завтрашнего дня. */
function dateLabel(showingAt: Date): string {
  const wall = dushanbeWallClock(showingAt);
  return `${wall.getUTCDate()} ${MONTHS_RU[wall.getUTCMonth()]}`;
}

/**
 * «сегодня в 15:00» / «завтра» — по календарю Душанбе, а не по UTC.
 * Час добавляется, только если он настоящий (см. hasRealShowingHour).
 */
function whenLabel(showingAt: Date, now: Date, lang: "ru" | "tg" = "ru"): string {
  const today = dushanbeDayRange(now);
  const tomorrowEnd = new Date(today.end.getTime() + 24 * 60 * 60 * 1000);
  const day =
    showingAt < today.end
      ? lang === "ru"
        ? "сегодня"
        : "имрӯз"
      : showingAt < tomorrowEnd
        ? lang === "ru"
          ? "завтра"
          : "пагоҳ"
        : dateLabel(showingAt);
  if (!hasRealShowingHour(showingAt)) return day;
  return lang === "ru" ? `${day} в ${timeLabel(showingAt)}` : `${day} соати ${timeLabel(showingAt)}`;
}

/**
 * Текст просьбы. Две строки — русская и таджикская: клиенты пишут и так и так, а
 * гадать о языке ради одного короткого сообщения дороже, чем отправить оба.
 * Просим ответить ОДНИМ словом — чем меньше усилие, тем выше доля ответивших.
 *
 * ЭТОТ ШАБЛОН ОБЯЗАН СОБЛЮДАТЬ ПРАВИЛА БОТА (разбор живых переписок 22.08.2026).
 * Клиент видит одно сообщение от компании и не знает, где кончается модель и
 * начинается шаблон, — а этот текст нарушал сразу три правила из BOT_CORE_RULES и
 * держал большинство срабатываний по всему проду:
 *
 *  1. ТИРЕ (правило 11). Было три «—» на три строки. Живой человек их в мессенджере
 *     не печатает, это самая заметная примета машины. Заменены двоеточием и точкой.
 *  2. ОБРАЩЕНИЕ ПО НИКУ (правило 10). Имя бралось из карточки как есть, а у клиента
 *     из Instagram там лежит ник: живое сообщение начиналось с «Здравствуйте,
 *     @daler9000xx!». Теперь имя подставляется, только если это правда имя
 *     (looksLikeRealName, ai/replyGuards.ts), иначе обращения нет вовсе.
 *  3. ДВОЙНОЕ ПРИВЕТСТВИЕ. Напоминание прилетает в СЕРЕДИНУ идущей переписки, а
 *     здоровалось дважды — по-русски и по-таджикски. Человек читает это как «бот
 *     забыл, с кем говорит». Приветствий не осталось ни одного: начинаем с дела.
 */
function confirmationText(name: string | null, showingAt: Date, propertyTitle: string | null, now: Date): string {
  const opening = looksLikeRealName(name) ? `${name!.trim()}, напоминаем` : "Напоминаем";
  const what = propertyTitle ? `, ${propertyTitle}` : "";
  return (
    `${opening} про показ ${whenLabel(showingAt, now)}${what}.\n` +
    `Подтвердите, пожалуйста, что придёте: ответьте «да».\n\n` +
    `Намоиши хона ${whenLabel(showingAt, now, "tg")}. Лутфан тасдиқ кунед, ки меоед: «ҳа» нависед.`
  );
}

/** Приписка к push агенту о состоянии подтверждения. Пустая, пока не спрашивали. */
function confirmationNote(task: {
  type: string;
  confirmAskedAt: Date | null;
  confirmedAt: Date | null;
  declinedAt: Date | null;
}): string {
  if (task.type !== "SHOWING" || !task.confirmAskedAt) return "";
  if (task.declinedAt) return "\n❗ Клиент сказал, что не сможет";
  if (task.confirmedAt) return "\n✅ Клиент подтвердил";
  return "\n⚠️ Клиент не подтвердил — позвоните";
}

/**
 * Просьба клиенту подтвердить показ.
 *
 * Идемпотентность на двух замках: колонка confirmAskedAt (по ней же идёт выборка)
 * и ступень CONFIRM_ASK_STAGE в remindersSent — том же массиве, где живут ступени
 * обычных напоминаний.
 *
 * ОТМЕТКА СТАВИТСЯ ДО ОТПРАВКИ, УСЛОВНО (№172 ночной проверки 24.09). Раньше —
 * после доставки, и рестарт процесса между отправкой и отметкой (каждый выкат)
 * давал клиенту вторую просьбу. Теперь `updateMany` по `confirmAskedAt: null`:
 * кто поставил — тот шлёт, второй проход показ уже не возьмёт. Не дошло —
 * отметка снимается, и следующий тик пробует снова, как и раньше: тихо
 * «подтвердить» отправку, которой не было, по-прежнему нельзя. Остаётся только
 * падение процесса посреди самой отправки — тогда просьба не повторится, а
 * агент увидит «не подтвердил — позвоните»; это мягче второго сообщения клиенту.
 */
export async function sendShowingConfirmationRequests(now: Date = new Date()): Promise<number> {
  // Выключаемо ДВУМЯ настройками, и обе должны быть включены. Проверяем первым,
  // до всех остальных фильтров и запроса к базе:
  //  - askClientsToConfirmShowings — директорский рубильник самого процесса
  //    (по умолчанию false с 18.08.2026 — владелец: «такие уведомления клиенту
  //    не должны приходить»);
  //  - botCanConfirmShowings — ползунок «Просить подтверждение встречи» на
  //    вкладке «Бот». До 26.08.2026 он вычислялся в capability, которую не
  //    читала НИ ОДНА строка кода: владелец выключал его и справедливо ждал
  //    тишины, а просьбы продолжали уходить. Теперь ползунок честно работает.
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { askClientsToConfirmShowings: true, botCanConfirmShowings: true },
  });
  if (!s?.askClientsToConfirmShowings || !s.botCanConfirmShowings) return 0;

  // Второй фильтр: ночью клиенту не пишем вообще. Даже если показ
  // ранний и «пора» — такие уже перенесены на вчерашний вечер (confirmationDueAt),
  // а всё, что сюда всё-таки дотянулось, подождёт до 09:00.
  if (!isWithinDushanbeWindow(CLIENT_DAY_START, CLIENT_DAY_END, now)) return 0;

  const showings = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      type: "SHOWING",
      completedAt: null,
      confirmAskedAt: null,
      // Клиенту не пишем «подтвердите показ» про объект, ушедший с продажи
      // (аудит 02.10.2026): такие показы снимаются при смене статуса, это — страховка.
      OR: [{ propertyId: null }, { property: { status: { notIn: ["SOLD", "WITHDRAWN"] } } }],
      nextActionDate: {
        gte: new Date(now.getTime() + CONFIRM_MIN_LEAD_MS),
        lte: new Date(now.getTime() + CONFIRM_HORIZON_MS),
      },
    },
    orderBy: { nextActionDate: "asc" },
    // Предел выборки: за один тик больше и не нужно, остальное догонит следующий.
    take: 100,
    select: {
      id: true,
      clientId: true,
      nextActionDate: true,
      remindersSent: true,
      client: { select: { fullName: true, kind: true } },
      property: { select: { title: true } },
    },
  });

  // Одним запросом на всех клиентов сразу: findClientDeliveryTarget в цикле по
  // до 100 показам держал до 200 обращений к базе на тик (этот крон — раз в 5 минут).
  const targets = await findClientDeliveryTargets(showings.map((s) => s.clientId));

  let sent = 0;
  for (const showing of showings) {
    try {
      if (!showing.nextActionDate || !hasExactTime(showing.nextActionDate)) continue;
      if (showing.remindersSent.includes(CONFIRM_ASK_STAGE)) continue;
      if (now < confirmationDueAt(showing.nextActionDate)) continue;

      // Мессенджера у клиента может не быть вовсе (пришёл по звонку) — тогда
      // спрашивать некуда. Показ остаётся неспрошенным, и сигнала «не подтвердил»
      // по нему не будет: винить человека за неотвеченное сообщение, которого мы не
      // отправляли, нельзя.
      const target = targets.get(showing.clientId);
      if (!target) continue;

      const text = confirmationText(showing.client.fullName, showing.nextActionDate, showing.property?.title ?? null, now);
      const claimed = await prisma.interaction.updateMany({
        where: { id: showing.id, confirmAskedAt: null },
        data: { confirmAskedAt: new Date(), remindersSent: { push: CONFIRM_ASK_STAGE } },
      });
      if (claimed.count !== 1) continue; // показ уже спросил другой проход
      const result = await deliverToConversation(target, text).catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (!result.ok) {
        console.error(`[showing] просьба подтвердить не ушла (${showing.id}): ${result.error}`);
        // Снять отметку: следующий тик попробует снова (см. докстринг).
        const current = await prisma.interaction.findUnique({ where: { id: showing.id }, select: { remindersSent: true } });
        await prisma.interaction.update({
          where: { id: showing.id },
          data: {
            confirmAskedAt: null,
            remindersSent: (current?.remindersSent ?? []).filter((stage) => stage !== CONFIRM_ASK_STAGE),
          },
        });
        continue;
      }
      sent++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Просьба подтвердить показ", showing.id, err);
    }
  }
  return sent;
}

/**
 * «Клиент не подтвердил» — агенту, заранее.
 *
 * Ради этого вся затея и существует: не отменить показ, а дать агенту повод
 * позвонить ДО того, как он зря поехал через весь город. Поэтому здесь нет и не
 * должно появиться ни одного update, меняющего сам показ.
 *
 * Условие «прошло MIN_ANSWER_MS с момента просьбы» обязательно: иначе при показе,
 * назначенном впритык, просьба и сигнал ушли бы на одном тике.
 */
export async function notifyUnconfirmedShowings(now: Date = new Date()): Promise<number> {
  if (!isWithinDushanbeWindow(AGENT_DAY_START, AGENT_DAY_END, now)) return 0;

  const showings = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      type: "SHOWING",
      completedAt: null,
      confirmedAt: null,
      declinedAt: null,
      confirmAskedAt: { not: null, lte: new Date(now.getTime() - MIN_ANSWER_MS) },
      nextActionDate: { gt: now, lte: new Date(now.getTime() + UNCONFIRMED_LEAD_MS) },
    },
    orderBy: { nextActionDate: "asc" },
    take: 100,
    select: {
      id: true,
      agentId: true,
      subjectAgentId: true,
      nextActionDate: true,
      remindersSent: true,
      client: { select: { fullName: true, kind: true, phone: true, shortId: true } },
      property: { select: { title: true } },
    },
  });

  let notified = 0;
  for (const showing of showings) {
    try {
      if (!showing.nextActionDate || !hasExactTime(showing.nextActionDate)) continue;
      if (showing.remindersSent.includes(CONFIRM_NUDGE_STAGE)) continue;
      const ownerId = showing.subjectAgentId ?? showing.agentId;
      if (!ownerId) continue;

      // Отметка — без оглядки на успех push (см. комментарий у sendHourBeforeReminders
      // выше): агент без активной подписки иначе получал бы этот пуш на каждом тике,
      // пока показ не наступит, а не один раз.
      await sendPushToAgent(ownerId, {
        kind: "showing",
        title: "❗ Клиент не подтвердил показ",
        body:
          `${formatClientName(showing.client)} · ${showing.client.phone ?? "телефон не указан"} — ` +
          `показ в ${timeLabel(showing.nextActionDate)}${showing.property ? ` · ${showing.property.title}` : ""}. ` +
          `Позвоните: это не отказ, просто не ответил.`,
        url: `/clients/${showing.client.shortId}`,
        tag: `showing-unconfirmed-${showing.id}`,
      });

      await prisma.interaction.update({
        where: { id: showing.id },
        data: { remindersSent: { push: CONFIRM_NUDGE_STAGE } },
      });
      notified++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Неподтверждённый показ — агенту", showing.id, err);
    }
  }
  return notified;
}

/** Через сколько после назначенного времени показ считается непроведённым. Два часа:
 *  показ длится дольше получаса, агент физически не сядет отмечать его сразу. */
const NO_SHOW_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * «Показ не проведён» — руководству (решение владельца 30.07: «а если не провёл
 * показ, то мне приходит уведомление, чтобы я с него спросил»).
 *
 * Непроведённым считается показ с указанным временем, который не отмечен
 * выполненным через NO_SHOW_AFTER_MS после назначенного часа. Отметка
 * noShowNotifiedAt — чтобы спросить один раз, а не на каждом тике.
 *
 * Отсекаем совсем старое (сутки): при первом запуске джоба на живой базе иначе
 * прилетел бы залп по всем неотмеченным показам за всю историю.
 */
export async function notifyMissedShowings(now: Date = new Date()): Promise<number> {
  // Штраф + пуш САМОМУ АГЕНТУ — не будим ночью; встречи СЕГОДНЯ
  // (sendHourBeforeReminders) под этот гейт намеренно не попадают. Пуш
  // РУКОВОДСТВУ по этой же пачке — отдельно, notifySupervisorsOfOverdue ниже,
  // на своём гейте (часы алармов, не рабочие часы агента).
  if (!(await isWithinWorkingHours(now))) return 0;
  const to = new Date(now.getTime() - NO_SHOW_AFTER_MS);
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const missed = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      type: "SHOWING",
      completedAt: null,
      noShowNotifiedAt: null,
      nextActionDate: { gte: from, lte: to },
    },
    select: {
      id: true,
      agentId: true,
      subjectAgentId: true,
      nextAction: true,
      nextActionDate: true,
      agent: { select: { fullName: true } },
      client: { select: { fullName: true, kind: true, shortId: true } },
      property: { select: { title: true } },
    },
  });
  if (missed.length === 0) return 0;

  const points = await loadEventPoints();
  let notified = 0;
  for (const task of missed) {
    try {
      if (!task.nextActionDate || !hasExactTime(task.nextActionDate)) continue;
      const ownerId = task.subjectAgentId ?? task.agentId;
      if (!ownerId) continue;

      // Royal Score: «Показ пропущен» (таблица владельца, п. 13) — БЕЗ ОГЛЯДКИ на
      // успех push ниже. Штраф зависит от факта («показ не проведён»), а не от того,
      // получилось ли кого-то уведомить: если бы событие писалось только вместе с
      // push, отсутствие подписки у всех руководителей (или сбой push-сервиса) тихо
      // отменяло бы штраф — ФАКТ пропущенного показа тут ни при чём. Дубль при
      // повторном тике исключён уникальностью по sourceId, а не этим условием.
      // await обязателен: ниже ставится noShowNotifiedAt, после которого второго тика
      // по этой записи не будет — незавершённая фоновая запись теряла бы штраф молча.
      await recordScoreEvent({
        agentId: ownerId,
        kind: "showing_missed",
        delta: points.showing_missed,
        reason: "Показ не проведён и не отмечен",
        sourceId: task.id,
      });

      await prisma.interaction.update({ where: { id: task.id }, data: { noShowNotifiedAt: new Date() } });
      notified++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Неотмеченный показ — руководителю", task.id, err);
    }
  }

  // Пуш РУКОВОДСТВУ по этой же пачке — отдельным, независимым сборщиком
  // (notifySupervisorsOfOverdue ниже), не отсюда: тот шлётся только в часы
  // алармов (Settings.alarmHours*), а этот тик — просто по рабочим часам
  // агента. Раньше оба уходили одним пушем под одним гейтом (владелец
  // 07.09.2026, разбор часов алармов).

  // Пуш и запись в ленту САМОМУ агенту «Показ не отмечен» УБРАНЫ (решение
  // владельца 02.10.2026: уведомления-«пилилки» агенту не нужны). Штраф
  // showing_missed и отметка noShowNotifiedAt — выше, не тронуты.
  return notified;
}

/**
 * «Встреча/задача просрочена» (таблица владельца, п. 15) — для НИКОГДА не закрытых
 * записей. Показ сюда не входит — у него своя ветка выше (notifyMissedShowings) со
 * своим текстом push, а штраф showing_missed уже общий на оба пути.
 *
 * ПОЧЕМУ НЕ НУЖНО РАЗЛИЧАТЬ «просрочено и потом закрыли поздно» И «так и не
 * закрыли»: оба пути пишут одно и то же событие с sourceId = id записи, а
 * уникальность (kind, sourceId) в журнале сама не даст начислить штраф дважды —
 * какой бы путь ни сработал первым (эта функция раньше, чем агент закрыл её сам
 * через PATCH /interactions/:id/complete, или наоборот).
 */
export async function notifyOverdueTasks(now: Date = new Date()): Promise<number> {
  // Штраф + пуш САМОМУ АГЕНТУ — не будим ночью; встречи СЕГОДНЯ
  // (sendHourBeforeReminders) под этот гейт намеренно не попадают. Пуш
  // РУКОВОДСТВУ по этой же пачке — отдельно, notifySupervisorsOfOverdue ниже,
  // на своём гейте (часы алармов, не рабочие часы агента).
  if (!(await isWithinWorkingHours(now))) return 0;
  const to = new Date(now.getTime() - NO_SHOW_AFTER_MS);
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const overdue = await prisma.interaction.findMany({
    where: {
      ...TASK_WHERE,
      type: { not: "SHOWING" },
      completedAt: null,
      noShowNotifiedAt: null,
      nextActionDate: { gte: from, lte: to },
    },
    select: {
      id: true,
      type: true,
      agentId: true,
      subjectAgentId: true,
      nextAction: true,
      nextActionDate: true,
      agent: { select: { fullName: true } },
      client: { select: { fullName: true, kind: true, shortId: true } },
    },
  });
  if (overdue.length === 0) return 0;

  const points = await loadEventPoints();
  let notified = 0;
  for (const task of overdue) {
    try {
      if (!task.nextActionDate || !hasExactTime(task.nextActionDate)) continue;
      const ownerId = task.subjectAgentId ?? task.agentId;
      if (!ownerId) continue;

      const isMeeting = task.type === "MEETING";
      const kind: ScoreEventKind = isMeeting ? "meeting_overdue" : "task_overdue";
      // await — по той же причине, что и в notifyMissedShowings выше.
      await recordScoreEvent({
        agentId: ownerId,
        kind,
        delta: points[kind],
        reason: isMeeting ? "Встреча просрочена — итог не заполнен" : "Задача просрочена",
        sourceId: task.id,
      });

      await prisma.interaction.update({ where: { id: task.id }, data: { noShowNotifiedAt: now } });
      notified++;
    } catch (err) {
      // Сбой одной записи не обрывает тик для остальных (№173 ночной проверки 24.09).
      reportCronRowError("Просроченная задача — руководителю", task.id, err);
    }
  }

  // Пуш руководству — см. комментарий у notifyMissedShowings выше:
  // notifySupervisorsOfOverdue ниже собирает эту же пачку отдельно, только в
  // часы алармов (владелец 07.09.2026).

  // Пуш и запись в ленту САМОМУ агенту «Встреча/Задача просрочена» УБРАНЫ
  // (решение владельца 02.10.2026). Штраф и отметка noShowNotifiedAt — выше.
  return notified;
}

/**
 * ПУШ РУКОВОДСТВУ ПО НЕПРОВЕДЁННЫМ ПОКАЗАМ/ПРОСРОЧЕННЫМ ВСТРЕЧАМ И ЗАДАЧАМ —
 * ОТДЕЛЬНЫЙ СБОРЩИК, В ЧАСЫ АЛАРМОВ (владелец 07.09.2026).
 *
 * Раньше этот пуш уходил ИЗНУТРИ notifyMissedShowings/notifyOverdueTasks, тем
 * же пушем и тем же гейтом (isWithinWorkingHours), что и пуш агенту, чья
 * запись просрочена, — то есть в рабочие часы АГЕНТА, а не в часы алармов
 * директора. Штраф Royal Score и пуш агенту остаются там же и на том же
 * гейте — трогать их нельзя, это KPI-начисление. Здесь — независимая копия
 * того же события для руководства, с собственным гейтом и собственной
 * отметкой (Interaction.supervisorNotifiedAt), не связанной с noShowNotifiedAt
 * агентской стороны: одно не блокирует другое ни в какую сторону.
 *
 * Окно выборки то же [now-24ч; now-NO_SHOW_AFTER_MS], что и у агентской
 * стороны — специально НЕ завязано на noShowNotifiedAt (тот может быть уже
 * проставлен рабочими часами агента задолго до часов алармов, а может и не
 * быть — оба случая обязаны попасть в это окно).
 */
export async function notifySupervisorsOfOverdue(now: Date = new Date()): Promise<number> {
  if (!(await isWithinAlarmHours(now))) return 0;
  const to = new Date(now.getTime() - NO_SHOW_AFTER_MS);
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [missedShowings, overdueOther] = await Promise.all([
    prisma.interaction.findMany({
      where: {
        ...TASK_WHERE,
        type: "SHOWING",
        completedAt: null,
        supervisorNotifiedAt: null,
        nextActionDate: { gte: from, lte: to },
      },
      select: {
        id: true,
        nextAction: true,
        nextActionDate: true,
        agent: { select: { fullName: true } },
        subjectAgent: { select: { fullName: true } },
        client: { select: { fullName: true, kind: true, shortId: true } },
        property: { select: { title: true } },
      },
    }),
    prisma.interaction.findMany({
      where: {
        ...TASK_WHERE,
        type: { not: "SHOWING" },
        completedAt: null,
        supervisorNotifiedAt: null,
        nextActionDate: { gte: from, lte: to },
      },
      select: { id: true, nextActionDate: true },
    }),
  ]);

  const showingLines = missedShowings
    .filter((t) => t.nextActionDate && hasExactTime(t.nextActionDate))
    .map((t) => ({
      id: t.id,
      line: `${t.subjectAgent?.fullName ?? t.agent?.fullName ?? "Агент"}: ${formatClientName(t.client)}${t.property ? ` · ${t.property.title}` : ""} — был назначен на ${timeLabel(t.nextActionDate!)}`,
      url: `/clients/${t.client.shortId}`,
    }));
  // Сводка руководству «Просрочено: N задач/встреч» убрана по решению владельца
  // 02.10.2026; отметка supervisorNotifiedAt остаётся, чтобы задача не
  // возвращалась в выборку каждый тик.
  const taskLines = overdueOther
    .filter((t) => t.nextActionDate && hasExactTime(t.nextActionDate))
    .map((t) => ({ id: t.id }));

  if (showingLines.length === 0 && taskLines.length === 0) return 0;

  const supervisors = await findAgentsWithPermission("clients.assign");
  let notified = 0;

  if (showingLines.length > 0) {
    // Руководству — в колокольчик и на дашборд, без звонка телефона (владелец
    // 20.09.2026: «эскалация — прямо-таки пуш не нужно»).
    await notifyFeedOnly(supervisors, {
      kind: "showing",
      title: showingLines.length === 1 ? "Показ не отмечен" : `Показов не отмечено: ${showingLines.length}`,
      body: showingLines.map((f) => f.line).join("\n"),
      url: showingLines.length === 1 ? showingLines[0].url : "/oversight",
      tag: `no-show-batch-${now.getTime()}`,
    });
    await prisma.interaction.updateMany({
      where: { id: { in: showingLines.map((f) => f.id) } },
      data: { supervisorNotifiedAt: now },
    });
    notified += showingLines.length;
  }

  if (taskLines.length > 0) {
    await prisma.interaction.updateMany({
      where: { id: { in: taskLines.map((f) => f.id) } },
      data: { supervisorNotifiedAt: now },
    });
    notified += taskLines.length;
  }

  return notified;
}

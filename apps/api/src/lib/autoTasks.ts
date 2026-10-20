import { prisma } from "../db.js";
import { logTimeline, type TimelineActor, type TimelineTx } from "./timeline.js";
import type { InteractionType } from "../generated/prisma/client.js";

/**
 * ДЕДУП И АВТОЗАКРЫТИЕ АВТОЗАДАЧ (21.09.2026).
 *
 * Владелец 21.09.2026, дословно: «Просрочено задач: 102… эти задания преследуют
 * всех и они неправильные… плюс когда агенты делают действия на карточке
 * клиента и даже звонят по заданию, это не влияет, будто они зависли или не
 * работают». Задокументировано в docs/TASKS.md — «Автозадачи не видят
 * состоявшегося контакта».
 *
 * ДВА РАЗНЫХ ДЕФЕКТА, ОДИН МЕХАНИЗМ.
 *
 *  1. ДУБЛИ. Часть генераторов (`lib/telephony/incomingCalls.ts` на каждый
 *     пропущенный входящий, `lib/noAnswerStreak.ts::notifyNoAnswerEscalation`
 *     на каждую эскалацию) заводила НОВУЮ запись `Interaction` с nextAction
 *     без единой проверки, нет ли уже открытой такой же — на проде 21.09.2026
 *     это 81 задача «Перезвонить — клиент звонил сам…» на 32 клиентов
 *     (в среднем 2,5 на клиента). Текст нельзя использовать как ключ дедупа:
 *     он меняется («попытка 1 из 3» → «попытка 2 из 3», «ждёт 19 дн.» →
 *     «ждёт 20 дн.») — ровно из-за этого дубли и возникали там, где дедуп уже
 *     пытались делать по `notes.startsWith` (agentUnansweredAlarm.ts): совпадение
 *     находилось, но старую запись не обновляли, и число дней в ней застывало.
 *
 *  2. НЕ ЗАКРЫВАЮТСЯ ПО ФАКТУ. `lib/nextActionAutoClose.ts::closeStaleNextActions`
 *     уже существует и вызывается из части каналов (звонок через CRM, конвейер
 *     переписки, планирование показа) — но она гасит подсказку ЧЕРЕЗ
 *     `completedAt`, оставляя `nextAction` заполненным. `TASK_WHERE`
 *     (lib/tasks.ts) — единственный формальный источник правды о том, что
 *     считается задачей, — проверяет только `nextAction: { not: null }` и НЕ
 *     проверяет `completedAt`; часть потребителей (`kpi.ts`, `calendar.ts`,
 *     `ai/assistant.ts`, `meetingReminders.ts`) добавляют `completedAt: null`
 *     сами, часть — нет. «Измерение на проде», с которого начался этот отчёт,
 *     тоже считало ровно по `TASK_WHERE` без `completedAt` — то есть часть уже
 *     «закрытых» через `completedAt` подсказок в это число всё равно попадала.
 *     Поэтому автозакрытие здесь работает НАДЁЖНЕЕ: `nextAction: null` —
 *     задача буквально исчезает из выборки везде, а не только там, где
 *     потребитель не забыл дописать `completedAt: null`. Тот же приём уже
 *     существует в `routes/properties/crud.ts::applyCancellation` для отменённых
 *     показов.
 *
 * ОДИН МЕХАНИЗМ, А НЕ КОПИЯ ПРОВЕРКИ В КАЖДОМ ГЕНЕРАТОРЕ. Ключ дедупа —
 * `Interaction.autoTaskKind` (машинный тег «какой генератор завёл эту
 * задачу»), а не текст `nextAction`: у одного клиента одновременно может быть
 * открыта РУЧНАЯ задача (агент завёл сам, `autoTaskKind = null`) и АВТОМАТИЧЕСКАЯ
 * задача каждого из видов ниже — они никогда не путаются и не гасят друг
 * друга. Автозакрытие (`closeAutoTasks`) фильтрует строго по `autoTaskKind`,
 * поэтому ручные задачи оно не трогает НИКОГДА — снять то, что заводит
 * автоматика, автоматика умеет, снять то, что завёл человек, должен решить
 * тоже человек.
 *
 * `Interaction` пишется только через `lib/timeline.ts` (страж —
 * `tests/timeline-single-writer.test.ts`), поэтому ветка «создать» здесь идёт
 * через `logTimeline`, а ветка «обновить существующую» — обычный
 * `interaction.update`, как это уже делает `nextActionAutoClose.ts`.
 */

/**
 * Виды автозадач. Свободная строка (тот же приём, что `outcomeSource`/
 * `transcriptionStage` в schema.prisma) — новый вид заводится без миграции,
 * набор проверяется здесь же, а не типом БД.
 */
export const AUTO_TASK_KINDS = [
  /** «Перезвонить — клиент звонил сам и не дозвонился» (lib/telephony/incomingCalls.ts). */
  "inbound_missed_callback",
  /** «Перезвонить: клиент оставил сообщение…» (lib/telephony/voicemailIngest.ts). */
  "voicemail_callback",
  /** «Перезвонить: клиент говорил с консультантом на телефоне…» — свой клиент,
   *  трубку взял ИИ, а не агент (lib/telephony/liveVoiceConsultant.ts). */
  "consultant_callback",
  /** «Перезвонить — клиент не ответил (попытка N из M)» — исходящий через CRM
   *  (lib/telephony/callTracker.ts). */
  "no_answer_retry",
  /** «Проверить контакт с клиентом…» — эскалация руководителю после исчерпанных
   *  попыток (lib/noAnswerStreak.ts::notifyNoAnswerEscalation). */
  "no_answer_supervisor_check",
  /** «Ещё раз попробовать дозвониться…» — отложенный «хвост» после эскалации
   *  (lib/noAnswerStreak.ts::processNoAnswerTailAnchors). */
  "no_answer_tail_retry",
  /** «Написать в чат нельзя, окно закрыто — позвоните…» (lib/agentUnansweredAlarm.ts). */
  "chat_window_closed",
  /** «Добавьте объект по заявке…» — продавец без объекта (lib/dealStalePipeline.ts). */
  "deal_stale_seller_add_property",
  /** «Закройте сделку или обновите статус по заявке…» — покупатель без сделки
   *  (lib/dealStalePipeline.ts). */
  "deal_stale_buyer_close_deal",
] as const;

export type AutoTaskKind = (typeof AUTO_TASK_KINDS)[number];

export interface UpsertAutoTaskInput {
  clientId: string;
  kind: AutoTaskKind;
  /** Текст задачи — при повторном срабатывании ОБНОВЛЯЕТ существующую открытую
   *  запись (актуальное число дней/попыток), а не плодит вторую. */
  nextAction: string;
  nextActionDate: Date;
  /** `notes` новой записи (если задачу придётся завести впервые). У обновления
   *  существующей записи `notes` тоже подменяется этим текстом — так читающий
   *  хронологию видит тот же текст, что и в самой задаче. */
  notes: string;
  actor: TimelineActor;
  type?: InteractionType;
  tx?: TimelineTx;
}

export interface UpsertAutoTaskResult {
  interactionId: string;
  /** false — обновили уже существующую открытую автозадачу этого вида у клиента. */
  created: boolean;
}

/**
 * Завести автозадачу — или, если у клиента уже есть открытая (`nextAction` не
 * пуст, `completedAt` пуст) запись ТОГО ЖЕ вида, обновить её вместо второй копии.
 *
 * Для генераторов, которые сами создают запись `Interaction` с другими полями
 * (лог звонка, где `nextAction` — лишь одно из полей записи о самом звонке),
 * используйте `claimAutoTaskSlot` ниже — он не создаёт запись сам, только
 * решает, кому достанется nextAction.
 */
export async function upsertAutoTask(input: UpsertAutoTaskInput): Promise<UpsertAutoTaskResult> {
  const db = input.tx ?? prisma;
  const existing = await db.interaction.findFirst({
    where: { clientId: input.clientId, autoTaskKind: input.kind, nextAction: { not: null }, completedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    await db.interaction.update({
      where: { id: existing.id },
      data: { nextAction: input.nextAction, nextActionDate: input.nextActionDate, notes: input.notes },
    });
    return { interactionId: existing.id, created: false };
  }
  const result = await logTimeline({
    clientId: input.clientId,
    actor: input.actor,
    type: input.type ?? "SYSTEM",
    notes: input.notes,
    nextAction: input.nextAction,
    nextActionDate: input.nextActionDate,
    autoTaskKind: input.kind,
    tx: input.tx,
  });
  return { interactionId: result.id, created: true };
}

export interface ClaimAutoTaskSlotResult {
  /** true — у клиента ещё нет открытой автозадачи этого вида, `nextAction`/
   *  `nextActionDate`/`autoTaskKind` можно приписать своей новой записи. */
  assignToNewRecord: boolean;
  /** Открытая автозадача, которую только что продлили (`assignToNewRecord: false`) —
   *  вызывающему, которому надо поправить и её (кому адресована). */
  existingInteractionId?: string;
}

/**
 * Тот же дедуп, что `upsertAutoTask`, но для случая, когда запись
 * `Interaction`, к которой должен приклеиться `nextAction`, создаёт сам
 * вызывающий код (например лог звонка в `lib/telephony/incomingCalls.ts`) —
 * эта функция ничего не создаёт и не пишет `Interaction.create`.
 *
 * Если у клиента уже открыта автозадача этого вида — она ОБНОВЛЯЕТСЯ (текст,
 * срок) прямо здесь, а вызывающий код обязан оставить `nextAction`/
 * `nextActionDate`/`autoTaskKind` у СВОЕЙ новой записи пустыми (`assignToNewRecord:
 * false`). Если открытой ещё нет — вызывающий код сам проставляет их у своей
 * записи (`assignToNewRecord: true`), а сюда второй раз обращаться не нужно.
 */
export async function claimAutoTaskSlot(
  clientId: string,
  kind: AutoTaskKind,
  nextAction: string,
  nextActionDate: Date,
  tx?: TimelineTx
): Promise<ClaimAutoTaskSlotResult> {
  const db = tx ?? prisma;
  const existing = await db.interaction.findFirst({
    where: { clientId, autoTaskKind: kind, nextAction: { not: null }, completedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    await db.interaction.update({
      where: { id: existing.id },
      data: { nextAction, nextActionDate },
    });
    return { assignToNewRecord: false, existingInteractionId: existing.id };
  }
  return { assignToNewRecord: true };
}

/**
 * Снять открытые автозадачи клиента заданных видов — повод исчез (состоялся
 * разговор, ушло сообщение, появился объект, сделка закрыта).
 *
 * `nextAction: null` — не `completedAt`-only, как в `nextActionAutoClose.ts`
 * (см. докстринг файла выше: `TASK_WHERE` не фильтрует `completedAt`, и часть
 * потребителей эту проверку не дописывает). `completedAt` всё равно
 * проставляется — по нему построены существующие отчёты и KPI-дисциплина.
 *
 * Фильтр по `autoTaskKind: { in: kinds }` — единственная причина, по которой
 * это безопасно вызывать где угодно: ручная задача агента (`autoTaskKind =
 * null`) никогда не попадает в выборку и не снимается автоматикой.
 */
export async function closeAutoTasks(
  clientId: string | null | undefined,
  kinds: readonly AutoTaskKind[],
  now: Date = new Date(),
  tx?: TimelineTx
): Promise<number> {
  if (!clientId || kinds.length === 0) return 0;
  const db = tx ?? prisma;
  const result = await db.interaction.updateMany({
    where: {
      clientId,
      autoTaskKind: { in: [...kinds] },
      nextAction: { not: null },
      completedAt: null,
    },
    data: { nextAction: null, nextActionDate: null, completedAt: now },
  });
  return result.count;
}

/** Все виды «перезвонить», которые гасит состоявшийся разговор с клиентом
 *  (звонок с ответом, входящий или исходящий). */
export const CALLBACK_AUTO_TASK_KINDS = [
  "inbound_missed_callback",
  "voicemail_callback",
  "consultant_callback",
  "no_answer_retry",
  "no_answer_supervisor_check",
  "no_answer_tail_retry",
] as const satisfies readonly AutoTaskKind[];

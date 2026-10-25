import { prisma, type TxClient } from "../db.js";
import type { ShowingAction, ShowingRequest } from "../ai/botContract.js";
export type { ShowingAction, ShowingRequest } from "../ai/botContract.js";
import { sendPushToAgent } from "../push.js";
import { DUSHANBE_OFFSET_MS, dushanbeWallClock } from "./dushanbeTime.js";
import { loadDisciplineRules } from "./disciplineRules.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { recordInterest } from "./propertyInterest.js";
import { logTimeline } from "./timeline.js";
import { createShowingTx, rescheduleShowingTx, cancelShowingTx, lockShowingClientTx } from "./showingMutation.js";

/**
 * Бот САМ назначает показ объекта — не дожидаясь агента и не спрашивая у него разрешения.
 *
 * Почему оптимистично, без проверки занятости агента (решение владельца 31.07.2026):
 * настоящее событие, после которого возможна сделка, — это НАЗНАЧЕННЫЙ ПОКАЗ, а не
 * полученный номер телефона. Дословно: «показ можно сразу делать, если объект доступен;
 * пусть бот сразу назначает показ в любое разумное время, не ночью; всегда можно
 * организовать показ во время, что выбрал клиент; в редких случаях нельзя, но тогда
 * агент звонит и переносит встречу». То есть цена редкого конфликта (человек звонит и
 * переносит) заведомо ниже цены потерянного клиента, который ушёл, пока мы согласовывали.
 *
 * Договорённость живёт дальше самого назначения: клиент передумывает и просит другое
 * время («давайте не завтра, а в субботу») или отказывается вовсе. Это НЕ новые
 * встречи — см. bookShowing (перенос) и cancelShowing (отмена).
 *
 * Показ хранится там же, где его создаёт CRM руками агента (routes/clients.ts,
 * POST /clients/:id/interactions): Interaction с type=SHOWING, propertyId, временем в
 * nextActionDate и текстом задачи в nextAction. Отдельной модели встреч в CRM нет, и
 * заводить её здесь нельзя: на nextActionDate завязаны календарь, напоминания
 * (lib/meetingReminders.ts), контроль «показ не проведён» и KPI дисциплины.
 */

/**
 * Часы, в которые бот вправе назначить показ (время Душанбе).
 *
 * Это НЕ Settings.workHoursStart/End. Те часы означают ровно одно — с какого момента
 * готовый лид отдаётся агенту (см. lib/workingHours.ts и утреннюю волну в leads.ts), и
 * заканчиваются в 18:00. А самый частый реальный показ — как раз после работы клиента,
 * в 18:00–20:00: взяв рабочие часы, бот отказывал бы именно в том времени, ради
 * которого клиент и пишет. Обратное тоже верно: показ в 09:00 нормален, хотя лиды
 * начинают раздаваться в 09:30. Поэтому у показов свои границы, а «не ночью» из
 * требования владельца — это про них.
 */
export const SHOWING_HOURS_START = "09:00";
/** Последнее время, на которое можно назначить показ (включительно). */
export const SHOWING_HOURS_LAST = "20:00";

/** Час по умолчанию для расплывчатого времени: «утром», «днём», «вечером».
 *  Вечер — 18:00: в Душанбе это время после работы, самый ходовой слот показа. */
const PART_OF_DAY_HOURS: Record<string, number> = {
  morning: 10,
  утро: 10,
  утром: 10,
  пагоҳӣ: 10,
  пагохи: 10,
  сахарӣ: 10,
  day: 14,
  afternoon: 14,
  день: 14,
  днём: 14,
  днем: 14,
  рӯзона: 14,
  рузона: 14,
  evening: 18,
  вечер: 18,
  вечером: 18,
  бегоҳӣ: 18,
  бегохи: 18,
  шом: 18,
};

/** Сколько дней вперёд считаем осмысленным горизонтом. Дальше — почти наверняка
 *  ошибка разбора даты (модель промахнулась годом), а не желание клиента. */
const MAX_AHEAD_DAYS = 30;

/** Минимальный запас времени: показ «через пять минут» никто не успеет провести —
 *  агенту нужно доехать (в Душанбе пробки, из-за них же две ступени напоминаний). */
const MIN_LEAD_MS = 30 * 60 * 1000;

/**
 * Сколько времени занимает один показ вместе с дорогой до следующего объекта.
 *
 * Нужно ровно для одного вопроса: клиент назвал ДРУГОЙ объект — он передумал или
 * хочет посмотреть оба? Две встречи ближе часа друг к другу на разных адресах —
 * это не план на вечер, а описка: человек физически не может быть в двух местах,
 * и такую пару мы считаем заменой объекта, а не второй договорённостью.
 */
const SHOWING_SLOT_MS = 60 * 60 * 1000;

/**
 * ЕДИНОЕ ПРАВИЛО «ЭТО ДУБЛЬ ПОКАЗА» (аудит 22.08.2026).
 *
 * До сегодняшнего дня правил было два, и они не знали друг о друге: здесь —
 * наложение слотов (SHOWING_SLOT_MS, час), в lib/scheduleShowing.ts —
 * hasNearbyShowing с окном ±4 часа. Один и тот же слот считался дублем или не
 * считался в зависимости от того, кто назначает: бот/детектор договорённости
 * или автоназначение по разбору звонка. Теперь запрос ОДИН (findConflictingShowing
 * ниже), а различается только ширина окна — и у каждой ширины своя причина:
 *
 *  • SHOWING_CONFLICT_WINDOW_MS (час) — физический факт: человек не бывает в двух
 *    местах разом, показ вместе с дорогой занимает час. Применяется там, где время
 *    и объект названы ЖИВЫМ человеком (клиент в переписке, агент в CRM): два показа
 *    в разных концах города через полтора часа — законный план на вечер, а не дубль.
 *  • SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS (4 часа) — щит для ПОЛНОСТЬЮ
 *    автоматического назначения из разбора звонка (ai/callAnalysis.ts): там и объект,
 *    и время — догадка модели по расшифровке, «в шесть» легко превращается в 18:05
 *    против назначенных агентом руками 18:00. Цена ошибки несимметрична: лишний
 *    автопоказ поверх ручного никто не заметит до самой встречи, а «не назначили
 *    автоматически» агент увидит сразу — окно «Назначьте показ» никуда не делось.
 */
export const SHOWING_CONFLICT_WINDOW_MS = SHOWING_SLOT_MS;

/** См. SHOWING_CONFLICT_WINDOW_MS: окно для автоназначения по разбору звонка. */
export const SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Отметка в Interaction.remindersSent: агенту УЖЕ сообщили, что клиент не придёт.
 *
 * Существует потому, что отказ клиента доезжает до нас двумя независимыми путями,
 * и оба срабатывают на одном и том же сообщении «не смогу»: разбор ответа на
 * просьбу подтвердить (lib/showingConfirmation.ts, ставит declinedAt) и ход бота с
 * action=cancel (cancelShowing здесь, снимает встречу с календаря). Агент получал
 * два push об одном событии — «❗ клиент не сможет прийти» и следом «🚫 клиент
 * отменил показ». Кто добежал первым, тот и уведомляет; второй молча доделывает
 * свою часть работы. Отметка ставится ПОСЛЕ доставки: не дошло — пусть сообщит
 * второй путь, это лучше молчания.
 */
export const DECLINE_NOTIFIED_STAGE = "decline-notified";

export type SlotProblem = "no_time" | "outside_hours" | "past" | "too_far";

export type ShowingSlot = { ok: true; at: Date } | { ok: false; reason: SlotProblem };

/** Часть суток или "HH:MM" → минуты от полуночи по Душанбе. null — разобрать не вышло. */
function parseTimeOfDay(raw: string | null | undefined): number | null {
  const norm = (raw ?? "").trim().toLowerCase();
  if (!norm) return null;
  const exact = norm.match(/^(\d{1,2})[:.](\d{2})$/);
  if (exact) {
    const h = Number(exact[1]);
    const m = Number(exact[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }
  // «в шесть» клиент говорит словами, но модель обязана вернуть цифры; голое число
  // ("18") принимаем как час — это единственная вольность, которую стоит прощать.
  const bare = norm.match(/^(\d{1,2})$/);
  if (bare) {
    const h = Number(bare[1]);
    return h <= 23 ? h * 60 : null;
  }
  const part = PART_OF_DAY_HOURS[norm];
  return part === undefined ? null : part * 60;
}

/** Календарный день показа В ЧАСАХ ДУШАНБЕ. Возвращаем именно поля даты, а не Date:
 *  реальный момент собирается ниже одним вычитанием сдвига, без setHours. */
function parseDay(raw: string | null | undefined, now: Date): { y: number; m: number; d: number } | null {
  const norm = (raw ?? "").trim().toLowerCase();
  if (!norm) return null;

  const offsets: Record<string, number> = {
    today: 0,
    сегодня: 0,
    имрӯз: 0,
    имруз: 0,
    tomorrow: 1,
    завтра: 1,
    пагоҳ: 1,
    пагох: 1,
    фардо: 1,
    fardo: 1,
    after_tomorrow: 2,
    day_after_tomorrow: 2,
    послезавтра: 2,
    пасфардо: 2,
  };

  const wall = dushanbeWallClock(now);
  if (norm in offsets) {
    // Date.UTC сам нормализует переход через конец месяца/года.
    const shifted = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + offsets[norm]));
    return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
  }

  const iso = norm.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };
  return null;
}

/** "HH:MM" из минут — для сравнения с границами показов (формат фиксирован, сравнение лексикографическое). */
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Расплывчатое «завтра вечером» / «пагоҳ соати шаш» → конкретный момент времени.
 *
 * Клиента не заставляем диктовать дату цифрами: слова про день и часть суток модель
 * приводит к day/time, а окончательное решение (не ночь ли, не прошло ли уже) принимает
 * этот разбор — детерминированно и в часах Душанбе, никогда через setHours.
 */
export function resolveShowingSlot(request: ShowingRequest, now: Date = new Date()): ShowingSlot {
  const minutes = parseTimeOfDay(request.time);
  const day = parseDay(request.day, now);
  if (minutes === null || !day) return { ok: false, reason: "no_time" };

  const label = hhmm(minutes);
  if (label < SHOWING_HOURS_START || label > SHOWING_HOURS_LAST) return { ok: false, reason: "outside_hours" };

  // Настенное время Душанбе → реальный момент. Ровно так же считаются границы суток
  // в lib/dushanbeTime.ts: контейнер живёт в UTC, часовой пояс процесса брать нельзя.
  const at = new Date(Date.UTC(day.y, day.m, day.d, Math.floor(minutes / 60), minutes % 60) - DUSHANBE_OFFSET_MS);
  const ahead = at.getTime() - now.getTime();
  if (ahead < MIN_LEAD_MS) return { ok: false, reason: "past" };
  if (ahead > MAX_AHEAD_DAYS * 24 * 60 * 60 * 1000) return { ok: false, reason: "too_far" };
  return { ok: true, at };
}

/** «31.07 в 18:00» по Душанбе — для push агенту. */
export function showingTimeLabel(at: Date): string {
  const wall = dushanbeWallClock(at);
  const dd = String(wall.getUTCDate()).padStart(2, "0");
  const mm = String(wall.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(wall.getUTCHours()).padStart(2, "0");
  const mi = String(wall.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm} в ${hh}:${mi}`;
}

/** An offset ISO instant from a customer tool is still subject to the SAME
 * showing hours, lead time and horizon as the existing conversation resolver.
 * Never silently round seconds into a different appointment. */
export function validateExactShowingSlot(at: Date, now: Date = new Date()): ShowingSlot {
  if (!Number.isFinite(at.getTime())) return { ok: false, reason: "no_time" };
  const wall = dushanbeWallClock(at);
  const day = `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}-${String(wall.getUTCDate()).padStart(2, "0")}`;
  const time = `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
  const slot = resolveShowingSlot({ day, time }, now);
  return slot.ok && slot.at.getTime() !== at.getTime() ? { ok: false, reason: "no_time" } : slot;
}

export type BookingProblem = SlotProblem | "no_property" | "unavailable" | "no_client" | "no_agent";

export type BookShowingResult =
  | {
      ok: true;
      interactionId: string;
      at: Date;
      propertyTitle: string;
      agentId: string | null;
      /** Время поменяли у уже назначенной встречи, а не завели новую. */
      rescheduled: boolean;
    }
  | { ok: false; reason: BookingProblem };

/** Понятный человеку разбор отказа — уходит агенту/руководству push'ом, чтобы просьбу
 *  клиента разобрал человек, а не потеряли молча. */
const PROBLEM_TEXT: Record<BookingProblem, string> = {
  no_time: "просит показ, но время понять не удалось",
  outside_hours: `просит показ вне разумных часов (${SHOWING_HOURS_START}–${SHOWING_HOURS_LAST})`,
  past: "просит показ на время, которое уже прошло или наступит слишком скоро",
  too_far: "просит показ на слишком далёкую дату",
  no_property: "просит показ объекта, которого нет в базе",
  unavailable: "просит показ объекта, который уже недоступен",
  no_client: "просит показ, но карточки клиента нет",
  no_agent: "просит показ, но за клиентом и объектом не закреплён агент",
};

/**
 * Сообщить живому человеку, что бот показ НЕ назначил.
 *
 * Молчаливый отказ здесь — худший исход: клиент считает, что договорился, а в CRM
 * пусто. Пишем запись в карточку (её видно в хронологии) и шлём push тому, кто может
 * исправить: агенту клиента, а если агента ещё нет — тем, кто назначает лидов.
 */
async function reportBookingProblem(
  client: { id: string; shortId: number; fullName: string; assignedAgentId: string | null },
  reason: BookingProblem
): Promise<void> {
  const text = `${client.fullName} ${PROBLEM_TEXT[reason]} — свяжитесь и согласуйте время`;
  const payload = {
    title: "❗ Показ требует согласования",
    body: text,
    url: `/clients/${client.shortId}`,
    // Метка без времени: пока человек не разобрал ситуацию, второе такое же
    // уведомление заменит первое в шторке, а не добавится к нему.
    tag: `showing-manual-${client.id}`,
  };

  if (client.assignedAgentId) {
    // Interaction.agentId обязателен — без агента записывать не на кого, остаётся push.
    await prisma.interaction
      .create({
        data: {
          clientId: client.id,
          agentId: client.assignedAgentId,
          type: "SYSTEM",
          notes: `Бот не смог назначить показ: клиент ${PROBLEM_TEXT[reason]}`,
        },
      })
      .catch((err) => console.error("[showing] запись о несостоявшемся показе:", err instanceof Error ? err.message : err));
    await sendPushToAgent(client.assignedAgentId, payload).catch(() => {});
    return;
  }

  // Часы алармов (владелец 07.09.2026): без назначенного агента ставить в
  // работу мгновенно нечего и некому — это просто сигнал руководству, может
  // подождать окна.
  await enqueueDirectorAlert({ ...payload, recipientPermission: "clients.assign" });
}

/**
 * Назначает показ клиенту ЛИБО переносит уже назначенный и уведомляет агента.
 *
 * Показ создаётся ТОЛЬКО на объект, который есть в базе и доступен (status=AVAILABLE,
 * deletedAt=null): звать человека смотреть проданную квартиру хуже, чем не позвать вовсе.
 * Занятость агента при этом не проверяется намеренно — см. шапку файла.
 *
 * ПЕРЕНОС, А НЕ ВТОРАЯ ВСТРЕЧА. Если у клиента уже есть непрошедший показ на этот же
 * объект, время меняется У НЕГО. Решение принимается по базе, а не по слову модели:
 * фраза «давайте не завтра, а в субботу» с одинаковой лёгкостью приходит и как
 * action=book, и как action=reschedule, а цена ошибки несимметрична — лишняя запись
 * означает, что агент поедет на встречу, которой уже нет, а клиент будет ждать его в
 * другое время. Прошедший показ переносом не считается: встреча уже была (или уже
 * сорвалась), и разговор о новом времени — это новая встреча.
 *
 * СМЕНА ОБЪЕКТА — ТОЖЕ ПЕРЕНОС. «Давайте лучше посмотрим ту, вторую» раньше заводило
 * новую встречу, а старая оставалась висеть в календаре — агент ехал зря. Теперь
 * такая просьба двигает ту же запись на другой объект; когда считать её сменой, а
 * когда честным «хочу посмотреть обе» — см. isReplacementOfOtherShowing.
 */
export async function bookShowing(params: {
  clientId: string;
  request: ShowingRequest;
  /** Откуда договорённость — попадёт в текст записи (WHATSAPP/INSTAGRAM/TELEGRAM…). */
  channel?: string;
  /**
   * Кто на самом деле договорился. По умолчанию — бот по словам клиента (так вызывает
   * его сам бот, см. applyShowingRequestInBackground). Живой агент передаёт свой actor,
   * когда договорённость обнаружена в его РУЧНОМ ответе (см. operatorShowingDetector.ts,
   * найдено 20.08.2026): без этого запись и push были подписаны «бот назначил показ» о
   * действии, которое агент только что сделал сам, — то же смешение, от которого
   * pushTarget() уже защищает перенос и отмену, но не саму первую запись показа.
   */
  actor?: ShowingActor;
  now?: Date;
}): Promise<BookShowingResult> {
  const now = params.now ?? new Date();
  const actor: ShowingActor = params.actor ?? { kind: "client", channel: params.channel };
  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: { id: true, shortId: true, fullName: true, phone: true, assignedAgentId: true },
  });
  if (!client) return { ok: false, reason: "no_client" };

  const fail = async (reason: BookingProblem): Promise<BookShowingResult> => {
    await reportBookingProblem(client, reason);
    return { ok: false, reason };
  };

  const slot = resolveShowingSlot(params.request, now);
  if (!slot.ok) return fail(slot.reason);

  const code = params.request.propertyCode;
  const codeNumber = typeof code === "number" ? code : /^\d+$/.test(String(code ?? "")) ? Number(code) : null;
  if (codeNumber === null && !code) return fail("no_property");

  // Ищем СНАЧАЛА без фильтра доступности: «объекта нет» и «объект уже продан» — разные
  // истории, и агенту полезно знать, какая именно.
  const property = await prisma.property.findFirst({
    where: codeNumber !== null ? { shortId: codeNumber } : { id: String(code) },
    select: { id: true, title: true, status: true, deletedAt: true, assignedAgentId: true, sellerClientId: true },
  });
  if (!property) return fail("no_property");
  if (property.status !== "AVAILABLE" || property.deletedAt) return fail("unavailable");

  // Кто поедет показывать: агент клиента, иначе агент объекта. Своего распределения
  // здесь нет специально — назначить лид посреди ночи (см. deferAssignment в leads.ts)
  // значит запустить агенту счётчик принятия, пока он спит.
  const agentId = client.assignedAgentId ?? property.assignedAgentId;
  if (!agentId) return fail("no_agent");

  /**
   * ПРОВЕРКА И ВСТАВКА — В ОДНОЙ ТРАНЗАКЦИИ, ПОД БЛОКИРОВКОЙ СТРОКИ КЛИЕНТА
   * (гонка найдена аудитом 22.08.2026).
   *
   * Раньше поиск живого показа шёл обычным SELECT'ом ДО транзакции, а вставка —
   * в отдельной транзакции после. Между ними нет ни блокировки, ни уникального
   * ограничения по слоту, поэтому идемпотентность работала только для строго
   * последовательных повторов (повторная доставка вебхука ПОСЛЕ коммита первого
   * вызова). Сегодня починен lib/operatorShowingDetector.ts, который с 18.08 не
   * работал вовсе (схема Gemini отдавала 400 на каждый вызов), — и появилась
   * одновременность, которой физически не могло быть: на одном и том же сообщении
   * срабатывают и ход бота (applyShowingRequestInBackground без actor), и детектор
   * ручной договорённости агента (тот же вызов с actor.kind="agent"). Оба видели
   * пустоту и оба заводили Interaction типа SHOWING на один слот — два показа в
   * календаре агента.
   *
   * Приём тот же, что у /site-listing-upserted в routes/webhooks.ts (~369): строка
   * блокируется FOR UPDATE внутри транзакции, вторая доставка ждёт коммита первой и
   * видит уже созданную запись. Блокируем строку КЛИЕНТА, а не объекта: дублем
   * считается второй показ ОДНОМУ клиенту, объект при этом может быть и другим.
   * Уникального ограничения в БД для этого нет (и добавить его нечем: слот показа —
   * это nextActionDate живой записи, а не отдельная колонка).
   */
  type BookingRace =
    | { kind: "created"; interaction: { id: string; agentId: string } }
    /** Живой показ ЭТОГО объекта — его и просят подвинуть. */
    | { kind: "existing"; showing: NonNullable<Awaited<ReturnType<typeof findActiveShowing>>> }
    /** Живой показ ДРУГОГО объекта, который клиент меняет на этот. */
    | { kind: "other"; showing: NonNullable<Awaited<ReturnType<typeof findActiveShowing>>> };

  const outcome: BookingRace = await prisma.$transaction(async (tx): Promise<BookingRace> => {
    await lockShowingClientTx(tx, client.id);

    // Уже назначенная встреча по этому объекту — та самая, которую клиент и просит
    // подвинуть. Отменённые сюда не попадают: у них снят nextAction (см. cancelShowing).
    const existing = await findActiveShowing({ clientId: client.id, propertyId: property.id, now }, tx);
    if (existing?.nextActionDate) return { kind: "existing", showing: existing };

    // Показ этого объекта не назначен — но у клиента может быть живая встреча на
    // ДРУГОЙ объект, и тогда речь может идти как раз о ней («давайте лучше ту»).
    const onOther = await findActiveShowing({ clientId: client.id, now }, tx);
    if (onOther?.nextActionDate && isReplacementOfOtherShowing(params.request.action, onOther.nextActionDate, slot.at)) {
      return { kind: "other", showing: onOther };
    }

    // Тем же способом, что и CRM руками агента (routes/clients.ts): запись показа,
    // отметка контакта и счётчик просмотров объекта — одной транзакцией.
    //
    // Автор (П-10): actor.kind==="agent" — живой человек, ручной ответ в
    // переписке (operatorShowingDetector.ts), agentId = именно он; иначе бот
    // договорился словами клиента (actor.kind==="client" — название унаследовано
    // от старого поля, по сути это BOT). Показ ведёт `agentId` (клиента/объекта) —
    // он попадает в subjectAgentId у бота, чтобы встреча осталась в его
    // календаре/дашборде (dashboardMissionControl.ts, MissionControl.tsx читают
    // subjectAgentId ?? agentId — см. ниже по PR).
    const created = await createShowingTx(tx, {
      clientId: client.id, propertyId: property.id, at: slot.at, now,
      actor: actor.kind === "agent" ? { kind: "agent", agentId: actor.agentId } : { kind: "bot", channel: actor.channel },
      notes: `Показ назначен ${bookedBySuffix(actor)}`,
    });
    return { kind: "created", interaction: created };
  });

  // Тот же сигнал интереса, что и у показа, записанного агентом руками
  // (routes/clients/interactions.ts): для спроса неважно, кто нажал кнопку.
  if (outcome.kind === "created") {
    void recordInterest(property.id, "SHOWING", client.id);
    // Продавец узнаёт о показе своего объекта (пачка 10, 11.09.2026, п.6 —
    // flow-audit-lead-to-showing-11-09.md, ТОП-10 п.5). Тем же приёмом, что и
    // закрытие сделки продавцу (routes/deals.ts): отдельная карточка, без
    // прямой связи Deal↔Property, событие идёт через Property.sellerClientId.
    void notifySellerOfShowing(property, showingTimeLabel(slot.at)).catch((err) =>
      console.error("[showing] уведомление продавца:", err instanceof Error ? err.message : err)
    );
  }

  // Перенос делаем ПОСЛЕ коммита: rescheduleShowing открывает собственную транзакцию,
  // а вложенных транзакций в Prisma нет. Второго показа это уже не создаст — запись
  // существует, и обе одновременные доставки придут в один и тот же id.
  if (outcome.kind === "existing") {
    const existing = outcome.showing;
    // Идемпотентность: вебхук мессенджера доставляется повторно, и один и тот же ход
    // может прийти дважды — второй показ на то же время был бы дублем в календаре.
    if (existing.nextActionDate!.getTime() === slot.at.getTime()) {
      return {
        ok: true,
        interactionId: existing.id,
        at: slot.at,
        propertyTitle: property.title,
        agentId: existing.agentId,
        rescheduled: false,
      };
    }
    return rescheduleShowing({ client, property, existing, at: slot.at, actor, now });
  }

  if (outcome.kind === "other") {
    return rescheduleShowing({
      client,
      property,
      existing: outcome.showing,
      at: slot.at,
      actor,
      now,
    });
  }

  const interaction = outcome.interaction;
  const committedAgentId = interaction.agentId;

  // Агент должен узнать СРАЗУ, а не из календаря завтра: если время не подходит, у него
  // есть часы на то, чтобы позвонить клиенту и перенести. Кроме случая, когда
  // договорился он же сам, руками, — pushTarget гасит push об этом действии
  // (см. её докстринг), как и для переноса/отмены.
  const pushRecipient = pushTarget(committedAgentId, actor);
  if (pushRecipient) {
    await sendPushToAgent(pushRecipient, {
      title: actor.kind === "agent" ? "✅ Показ назначен" : "✅ Бот назначил показ",
      body: `${client.fullName} · ${property.title} — ${showingTimeLabel(slot.at)}. Не сможете — позвоните и перенесите.`,
      url: `/clients/${client.shortId}`,
      tag: `showing-${interaction.id}`,
    }).catch((err) => console.error("[push] показ от бота:", err instanceof Error ? err.message : err));
  }

  return {
    ok: true,
    interactionId: interaction.id,
    at: slot.at,
    propertyTitle: property.title,
    agentId: committedAgentId,
    rescheduled: false,
  };
}

/**
 * Живой (непрошедший и неотменённый) показ клиента. propertyId не задан — любой ближайший.
 *
 * `db` — клиент Prisma или транзакция. Проверять существующий показ нужно ВНУТРИ той
 * же транзакции, где происходит вставка (см. bookShowing, гонка 22.08.2026): проверка
 * снаружи не видит незакоммиченную запись параллельного вызова.
 */
async function findActiveShowing(
  params: { clientId: string; propertyId?: string; now: Date },
  db: TxClient = prisma
) {
  const found = await db.interaction.findFirst({
    where: {
      clientId: params.clientId,
      type: "SHOWING",
      ...(params.propertyId ? { propertyId: params.propertyId } : {}),
      completedAt: null,
      taskCancelledAt: null,
      // Признак живой задачи в CRM — непустой nextAction (lib/tasks.ts, TASK_WHERE).
      // Отменённый показ его теряет и переносу больше не подлежит.
      nextAction: { not: null },
      // Прошедший показ не переносим: встреча уже была, это уже новая договорённость.
      nextActionDate: { gte: params.now },
    },
    // Ближайший: если встреч почему-то оказалось несколько, клиент говорит о той,
    // которая наступит раньше.
    orderBy: { nextActionDate: "asc" },
    select: {
      id: true,
      agentId: true,
      subjectAgentId: true,
      propertyId: true,
      nextActionDate: true,
      notes: true,
      remindersSent: true,
      property: { select: { title: true } },
    },
  });
  if (!found) return found;
  // П-10: показ, записанный ботом, живёт в subjectAgentId (agentId у него null) —
  // весь код ниже (pushTarget, возвращаемые значения) читает поле `agentId` как
  // «чей это показ» независимо от того, кто его создал, поэтому нормализуем сразу.
  const { subjectAgentId, ...rest } = found;
  return { ...rest, agentId: found.agentId ?? subjectAgentId };
}

/**
 * Клиент назвал ДРУГОЙ объект: он передумал (это перенос) или хочет посмотреть оба
 * (это вторая встреча)?
 *
 * Обе трактовки законны — агент нередко показывает два-три объекта подряд, — поэтому
 * тут, в отличие от того же объекта, база сама ответить не может и нужен сигнал:
 *
 *  1. Модель прямо сказала "перенос" (action=reschedule). Для другого объекта это
 *     единственное, чем мы располагаем: слова «давайте лучше вторую» и «давайте
 *     заодно и вторую» отличаются только смыслом, а его понимает модель, не база.
 *     Ошибку видно сразу — push агенту называет и старый объект, и новый.
 *  2. Время новой встречи накладывается на уже назначенную (ближе SHOWING_SLOT_MS).
 *     Это уже факт, а не мнение: человек не бывает в двух местах разом, поэтому
 *     здесь мы не спрашиваем модель вовсе — «второй показ» в тот же час означает
 *     замену, чем бы его ни назвали.
 *
 * Во всех прочих случаях — вторая встреча. Цена ошибки тут обратная переносу: лучше
 * лишний показ в календаре (агент его увидит и уточнит), чем молча стёртая
 * договорённость, о которой клиент не подозревает.
 */
function isReplacementOfOtherShowing(action: ShowingAction | null | undefined, existingAt: Date, at: Date): boolean {
  if (action === "reschedule") return true;
  // То же окно, что и у общей проверки на дубль, — см. SHOWING_CONFLICT_WINDOW_MS.
  return Math.abs(at.getTime() - existingAt.getTime()) < SHOWING_CONFLICT_WINDOW_MS;
}

/**
 * ЖИВОЙ ПОКАЗ КЛИЕНТА, КОТОРЫЙ КОНФЛИКТУЕТ С ПРЕДЛАГАЕМЫМ ВРЕМЕНЕМ — одна проверка
 * на всю CRM (унификация 22.08.2026, см. SHOWING_CONFLICT_WINDOW_MS).
 *
 * Отличия от прежней hasNearbyShowing (lib/scheduleShowing.ts), и все они намеренные:
 *  • отменённый показ дублем не считается — у него снят nextAction (cancelShowing), а
 *    declinedAt проставляется НЕ всегда (например, показ, отменённый до 16.08.2026);
 *  • проведённый показ (completedAt) тоже не считается: встреча уже была, новая
 *    договорённость на её место — это нормальный следующий шаг, а не дубль;
 *  • прошедшее время отсекается — вчерашняя встреча ничему сегодня не мешает.
 * Все три случая раньше блокировали законное назначение показа.
 */
export async function findConflictingShowing(params: {
  clientId: string;
  at: Date;
  /** Ширина окна в обе стороны. По умолчанию — физический час показа с дорогой. */
  windowMs?: number;
  now?: Date;
  db?: Pick<TxClient, "interaction">;
}) {
  const windowMs = params.windowMs ?? SHOWING_CONFLICT_WINDOW_MS;
  const now = params.now ?? new Date();
  const db: Pick<TxClient, "interaction"> = params.db ?? prisma;
  const from = new Date(Math.max(now.getTime(), params.at.getTime() - windowMs));
  return db.interaction.findFirst({
    where: {
      clientId: params.clientId,
      type: "SHOWING",
      completedAt: null,
      taskCancelledAt: null,
      // Признак живой задачи в CRM (lib/tasks.ts, TASK_WHERE) — он же признак
      // «показ не отменён»: отмена снимает именно nextAction.
      nextAction: { not: null },
      declinedAt: null,
      nextActionDate: { gte: from, lte: new Date(params.at.getTime() + windowMs) },
    },
    orderBy: { nextActionDate: "asc" },
    select: { id: true, propertyId: true, nextActionDate: true },
  });
}

/** Короткая форма findConflictingShowing — для мест, которым важен только факт. */
export async function hasConflictingShowing(
  clientId: string,
  at: Date,
  options?: { windowMs?: number; now?: Date }
): Promise<boolean> {
  return (await findConflictingShowing({ clientId, at, ...options })) !== null;
}

/**
 * ДРУГОЙ ПОКАЗ ТОГО ЖЕ АГЕНТА пересекается по времени (пачка 10, 11.09.2026, п.2 —
 * flow-audit-lead-to-showing-11-09.md, ТОП-10 п.2). Занятость агента НАМЕРЕННО не
 * блокирует назначение (см. шапку файла, решение владельца 31.07.2026) — здесь
 * только предупреждение, не отказ: агент физически не может быть на двух показах
 * разом, но решает сам, что с этим делать (перенести один из них или успеть).
 */
export async function findAgentShowingConflict(params: {
  agentId: string;
  at: Date;
  /** Клиента, которому и назначается показ, — сам с собой не конфликтует. */
  excludeClientId: string;
  windowMs?: number;
  now?: Date;
}) {
  const windowMs = params.windowMs ?? SHOWING_CONFLICT_WINDOW_MS;
  const now = params.now ?? new Date();
  const from = new Date(Math.max(now.getTime(), params.at.getTime() - windowMs));
  return prisma.interaction.findFirst({
    where: {
      OR: [{ subjectAgentId: params.agentId }, { subjectAgentId: null, agentId: params.agentId }],
      clientId: { not: params.excludeClientId },
      type: "SHOWING",
      completedAt: null,
      taskCancelledAt: null,
      nextAction: { not: null },
      declinedAt: null,
      nextActionDate: { gte: from, lte: new Date(params.at.getTime() + windowMs) },
    },
    orderBy: { nextActionDate: "asc" },
    select: {
      id: true,
      nextActionDate: true,
      client: { select: { id: true, shortId: true, fullName: true } },
      property: { select: { title: true } },
    },
  });
}

/**
 * Кто двигает или снимает показ.
 *
 * Различать обязательно, и не ради красивого текста в карточке: агенту не нужен
 * push о действии, которое он только что сделал руками, — а вот о том, что показ
 * снял руководитель или бот по словам клиента, узнать он обязан.
 */
export type ShowingActor =
  /** Бот по прямым словам клиента в переписке. */
  | { kind: "client"; channel?: string }
  /** Живой человек в интерфейсе CRM. */
  | { kind: "agent"; agentId: string; agentName: string };

/** Хвост записи о ПЕРЕНОСЕ: «ботом (WHATSAPP)» либо «в CRM (Иванов)». */
function movedBySuffix(actor: ShowingActor): string {
  return actor.kind === "client" ? `ботом${actor.channel ? ` (${actor.channel})` : ""}` : `в CRM (${actor.agentName})`;
}

/** Хвост записи о НОВОМ показе: «ботом в переписке (WHATSAPP) по договорённости с
 *  клиентом» либо, когда договорился агент сам руками (найдено 20.08.2026,
 *  operatorShowingDetector.ts), «по переписке агента Иванов — определено автоматически»:
 *  соврать «назначил бот» о его собственном действии хуже, чем длинная запись. */
function bookedBySuffix(actor: ShowingActor): string {
  return actor.kind === "client"
    ? `ботом в переписке${actor.channel ? ` (${actor.channel})` : ""} по договорённости с клиентом`
    : `по переписке агента ${actor.agentName} — определено автоматически`;
}

/** Хвост записи об ОТМЕНЕ. Отменяет не бот, а клиент его словами, — так и пишем:
 *  через месяц по карточке должно быть видно, кто передумал. */
function cancelledBySuffix(actor: ShowingActor): string {
  return actor.kind === "client"
    ? `клиентом в переписке${actor.channel ? ` (${actor.channel})` : ""}`
    : `в CRM (${actor.agentName})`;
}

/**
 * Кому уходит push о переносе/отмене — и уходит ли вообще.
 *
 * Всегда агенту ЗАПИСИ: день планировал именно он, встреча в его календаре, и
 * освободившееся время тоже его. Кроме одного случая: он же сам это и сделал.
 */
function pushTarget(showingAgentId: string | null, actor: ShowingActor): string | null {
  if (!showingAgentId) return null;
  return actor.kind === "agent" && actor.agentId === showingAgentId ? null : showingAgentId;
}

/**
 * Двигает уже назначенный показ на новое время И, если клиент выбрал другой
 * объект, на другой объект.
 *
 * Запись остаётся ТА ЖЕ: у встречи один идентификатор на всю её жизнь, на него
 * завязаны напоминания, подтверждение и хронология клиента. Меняется время (и
 * объект), а прежнее дописывается в заметку — агенту важно видеть, с чего на что
 * переехало.
 */
async function rescheduleShowing(params: {
  client: { id: string; shortId: number; fullName: string };
  /** Объект, на котором должна пройти встреча. null — оставить прежний (перенос по времени). */
  property: { id: string; title: string } | null;
  existing: {
    id: string;
    agentId: string | null;
    propertyId: string | null;
    nextActionDate: Date | null;
    notes: string;
    property: { title: string } | null;
  };
  at: Date;
  actor: ShowingActor;
  /** Почему переносят — обязательна для ручного переноса из CRM (см.
   *  rescheduleShowingById), у бота её нет: слова клиента уже в notes. */
  reason?: string;
  now?: Date;
}): Promise<BookShowingResult> {
  const { client, property, existing, at, actor, reason } = params;
  const now = params.now ?? new Date();
  const byWhom = actor.kind === "client" ? "по просьбе клиента" : "решением агента";
  /** Хвост «Причина: …» — только когда её назвали (ручной перенос из CRM). */
  const reasonSuffix = reason ? `. Причина: ${reason}` : "";
  // Для сдвига «Итога показа» ниже — до транзакции, короткий запрос к Настройкам.
  const { meetingSummaryAfterShowingMinutes } = await loadDisciplineRules();

  const current = await prisma.$transaction((tx) => rescheduleShowingTx(tx, {
    clientId: client.id, interactionId: existing.id, at, now, propertyId: property?.id,
    meetingSummaryAfterShowingMinutes, actorKind: actor.kind,
    notes: (current) => {
      const previousAt = current.nextActionDate!;
      const previousTitle = current.property?.title ?? "прежний объект";
      return property && current.propertyId !== property.id
        ? `${current.notes}\nПеренесён ${movedBySuffix(actor)} на другой объект: ` +
          `«${previousTitle}» ${showingTimeLabel(previousAt)} → «${property.title}» ${showingTimeLabel(at)} ${byWhom}${reasonSuffix}`
        : `${current.notes}\nПеренесён ${movedBySuffix(actor)}: ` +
          `с ${showingTimeLabel(previousAt)} на ${showingTimeLabel(at)} ${byWhom}${reasonSuffix}`;
    },
  }));
  const wasAt = current.nextActionDate!;
  const movedToOtherProperty = !!property && current.propertyId !== property.id;
  const wasTitle = current.property?.title ?? "прежний объект";
  const nowTitle = property?.title ?? current.property?.title ?? "объект не указан";
  const effectiveAgentId = current.subjectAgentId ?? current.agentId;

  /* Здесь заводился «Итог показа» по старому времени — механизм обязательных
     окон удалён 13.09.2026, заводить нечего. Сам перенос и уведомления агенту
     ниже остаются: они к окнам отношения не имели. */

  // Смена объекта агента записи не меняет: он уже ведёт этого клиента.
  const notify = pushTarget(effectiveAgentId, actor);
  if (notify) {
    // Заголовок называет ВИНОВНИКА: «клиент перенёс» и «перенёс руководитель» —
    // для агента разные новости, и реагировать на них надо по-разному.
    const byClient = actor.kind === "client";
    const who = byClient ? "" : `${actor.agentName}: `;
    await sendPushToAgent(notify, {
      title: movedToOtherProperty
        ? byClient
          ? "🔄 Клиент выбрал другой объект"
          : "🔄 Показ переехал на другой объект"
        : byClient
          ? "🔄 Клиент перенёс показ"
          : "🔄 Показ перенесён",
      body: movedToOtherProperty
        ? `${who}${client.fullName} — вместо «${wasTitle}» ${showingTimeLabel(wasAt)} смотрит «${nowTitle}» ` +
          `${showingTimeLabel(at)}. Прежняя встреча снята.${reasonSuffix}`
        : `${who}${client.fullName} · ${nowTitle} — было ${showingTimeLabel(wasAt)}, стало ${showingTimeLabel(at)}.${reasonSuffix}`,
      url: `/clients/${client.shortId}`,
      // Тот же tag, что у назначения: в шторке остаётся ОДНО актуальное уведомление
      // про этот показ, а не стопка с разным временем, из которой непонятно, какое в силе.
      tag: `showing-${existing.id}`,
    }).catch((err) => console.error("[push] перенос показа:", err instanceof Error ? err.message : err));
  }

  return {
    ok: true,
    interactionId: existing.id,
    at,
    propertyTitle: nowTitle,
    agentId: effectiveAgentId,
    rescheduled: true,
  };
}

export type CancelShowingResult =
  | { ok: true; interactionId: string; at: Date; agentId: string | null }
  | { ok: false; reason: "no_client" | "no_showing" };

/**
 * Клиент отказался приезжать («не смогу», «передумал») — снимаем показ с календаря
 * агента, НЕ стирая историю.
 *
 * Как именно отражена отмена (решение осознанное, вариантов было три):
 *  - запись НЕ удаляется физически и время встречи (nextActionDate) остаётся: история
 *    договорённостей с клиентом ценнее чистоты таблицы, и агент должен видеть, что
 *    показ БЫЛ назначен и отменён, а не что его никогда не было;
 *  - снимается ровно одно поле — nextAction. По нему CRM отличает живую задачу от
 *    истории (lib/tasks.ts, TASK_WHERE), поэтому отменённый показ разом уходит из
 *    календаря, напоминаний, просьбы подтвердить и сигнала «показ не проведён»,
 *    оставаясь в хронологии клиента;
 *  - completedAt для этого НЕ используется: он означает «сделано» и в KPI (kpi.ts,
 *    computeCrm) засчитал бы агенту отменённую встречу как выполненную вовремя
 *    задачу. Но и оставить задачу висеть нельзя — это обратная несправедливость:
 *    просрочка и минус к дисциплине за то, что передумал клиент.
 *  - declinedAt проставляется как и при ответе на просьбу подтвердить
 *    (lib/showingConfirmation.ts). Вместе с пустым nextAction это и есть признак
 *    «показ отменён» — по нему отменённые встречи не попадают в цифры отчётов и
 *    доски почёта (lib/tasks.ts, COUNTED_SHOWING_WHERE).
 *
 * Сам показ отменяет БОТ по прямым словам клиента. Это не противоречит правилу
 * «молчание не отказ» из showingConfirmation: там отмены нет именно потому, что нет
 * и слов клиента, а здесь он сказал прямым текстом.
 */
export async function cancelShowing(params: {
  clientId: string;
  /** Код объекта, если клиент уточнил, о каком показе речь. */
  propertyCode?: number | string | null;
  channel?: string;
  /** См. комментарий у одноимённого параметра bookShowing. */
  actor?: ShowingActor;
  now?: Date;
}): Promise<CancelShowingResult> {
  const now = params.now ?? new Date();
  const client = await prisma.client.findUnique({
    where: { id: params.clientId },
    select: { id: true, shortId: true, fullName: true },
  });
  if (!client) return { ok: false, reason: "no_client" };

  const propertyId = await resolvePropertyId(params.propertyCode);
  // Сначала ищем показ по названному объекту, а если такого нет — ближайший любой.
  // Код объекта в отмене модель называет по памяти и вполне может промахнуться, а
  // человек, сказавший «не смогу», имеет в виду ту единственную встречу, которая у
  // него назначена. Промолчать здесь означало бы отправить агента на отменённый показ.
  const showing =
    (propertyId ? await findActiveShowing({ clientId: client.id, propertyId, now }) : null) ??
    (await findActiveShowing({ clientId: client.id, now }));
  if (!showing?.nextActionDate) return { ok: false, reason: "no_showing" };

  return applyCancellation({
    showing,
    client,
    actor: params.actor ?? { kind: "client", channel: params.channel },
    now,
  });
}

/**
 * Сама отмена — одна на все входы: бота, интерфейс CRM и всё, что появится дальше.
 *
 * Второе место, где показ снимается с календаря, рано или поздно разойдётся с
 * первым (забудут declinedAt — и отменённый показ вернётся в отчёты, забудут
 * запись в notes — и агент не поймёт, куда делась встреча). Поэтому вход один, а
 * различается только КТО отменил (ShowingActor).
 */
async function applyCancellation(params: {
  showing: {
    id: string;
    agentId: string | null;
    nextActionDate: Date | null;
    notes: string;
    remindersSent: string[];
    property: { title: string } | null;
  };
  client: { id: string; shortId: number; fullName: string };
  actor: ShowingActor;
  now: Date;
  /** Почему сняли встречу — обязательна для ручной отмены из CRM (см.
   *  cancelShowingById), у бота её нет: слова клиента уже в notes. Её наличие —
   *  и есть признак «отменил человек руками», по нему заводим задачу-напоминание
   *  ниже, чтобы клиент не завис без следующего шага. */
  reason?: string;
}): Promise<CancelShowingResult> {
  const { showing, client, actor, now, reason } = params;
  const reasonSuffix = reason ? `. Причина: ${reason}` : "";

  const current = await prisma.$transaction((tx) => cancelShowingTx(tx, {
    clientId: client.id, interactionId: showing.id, now, actorKind: actor.kind,
    notes: (locked) => `${locked.notes}\nОтменён ${cancelledBySuffix(actor)}: ` +
      `был назначен на ${showingTimeLabel(locked.nextActionDate!)}${reasonSuffix}`,
    ...(reason ? { followUp: {
      actor: actor.kind === "agent" ? { kind: "agent" as const, agentId: actor.agentId }
        : { kind: "bot" as const, source: "showingBooking.cancel", subjectAgentId: showing.agentId, channel: actor.channel },
      notes: `Показ отменён${reasonSuffix} — согласуйте с клиентом новую дату`,
    } } : {}),
  }));
  const at = current.nextActionDate!;
  // Второй раз об одном отказе не сообщаем — см. DECLINE_NOTIFIED_STAGE. На «не
  // смогу» срабатывают сразу два пути (разбор ответа на просьбу подтвердить и ход
  // бота с action=cancel), и агент получал два push об одном событии.
  const notify = current.remindersSent.includes(DECLINE_NOTIFIED_STAGE) ? null : pushTarget(current.subjectAgentId ?? current.agentId, actor);
  if (notify) {
    const delivered = await sendPushToAgent(notify, {
      title: actor.kind === "client" ? "❌ Клиент отменил показ" : "❌ Показ отменён",
      body:
        `${client.fullName}${showing.property ? ` · ${showing.property.title}` : ""} — показ ${showingTimeLabel(at)} ` +
        (actor.kind === "client"
          ? "отменён, время свободно. Позвоните и договоритесь о новом."
          : `снял(а) ${actor.agentName}, время свободно.${reasonSuffix}`),
      url: `/clients/${client.shortId}`,
      tag: `showing-${showing.id}`,
    }).catch((err) => {
      console.error("[push] отмена показа:", err instanceof Error ? err.message : err);
      return 0;
    });
    // Отметку ставим ПОСЛЕ доставки: не дошло — пусть сообщит второй путь, это
    // лучше, чем тихо считать агента предупреждённым.
    if (delivered > 0) {
      await prisma.interaction
        .update({ where: { id: showing.id }, data: { remindersSent: { push: DECLINE_NOTIFIED_STAGE } } })
        .catch(() => {});
    }
  }

  return { ok: true, interactionId: showing.id, at, agentId: current.subjectAgentId ?? current.agentId };
}

/* ─────────────── Отмена и перенос руками, из интерфейса CRM ──────────────────
 *
 * До этого отменить или подвинуть показ умел только бот, а агент — нет: он мог
 * лишь «отметить выполненной» встречу, которой не было, либо оставить её висеть
 * просроченной. Обе ветки врут: первая засчитывает несостоявшийся показ в KPI и
 * в отчёты, вторая портит агенту дисциплину за то, что передумал клиент.
 *
 * Логика отмены здесь НЕ дублируется: обе функции ниже — тонкие обёртки, которые
 * находят запись по id и отдают её в те же applyCancellation/rescheduleShowing,
 * которыми пользуется бот. Второе место, где показ снимается с календаря, рано или
 * поздно разойдётся с первым.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ShowingByIdProblem = "not_found" | "not_showing" | "already_cancelled" | "past";

/**
 * Показ, над которым ещё можно совершить действие.
 *
 * Прошедшее время здесь, в отличие от бота, НЕ отсекается намеренно: агент трогает
 * конкретную запись, которую сам выбрал в календаре, а самая частая причина зайти
 * в неё руками — как раз просроченная встреча («клиент не приехал, договорились на
 * завтра»). У бота запрет нужен потому, что запись он выбирает сам, по догадке.
 */
async function loadEditableShowing(interactionId: string) {
  const found = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: {
      id: true,
      type: true,
      agentId: true,
      subjectAgentId: true,
      propertyId: true,
      nextAction: true,
      nextActionDate: true,
      notes: true,
      completedAt: true,
      taskCancelledAt: true,
      remindersSent: true,
      property: { select: { title: true } },
      client: { select: { id: true, shortId: true, fullName: true } },
    },
  });
  if (!found) return { ok: false as const, reason: "not_found" as const };
  // П-10: показ от бота живёт в subjectAgentId — см. findActiveShowing выше.
  const { subjectAgentId, ...rest } = found;
  const showing = { ...rest, agentId: found.agentId ?? subjectAgentId };
  if (showing.type !== "SHOWING" || !showing.nextActionDate) return { ok: false as const, reason: "not_showing" as const };
  // Уже снятый показ (nextAction пуст) второй раз не отменяем и не двигаем: это
  // затёрло бы историю и выдало агенту второе уведомление о том же событии.
  if (!showing.nextAction || showing.completedAt || showing.taskCancelledAt) return { ok: false as const, reason: "already_cancelled" as const };
  return { ok: true as const, showing };
}

/** Отменить показ из CRM. Тот же путь, что у бота, — отличается только автор.
 *  `reason` обязателен (решение владельца 16.08.2026): без причины отмена руками
 *  ничем не отличалась от простого исчезновения встречи из хронологии. */
export async function cancelShowingById(params: {
  interactionId: string;
  actor: ShowingActor;
  reason: string;
  now?: Date;
}): Promise<CancelShowingResult | { ok: false; reason: ShowingByIdProblem }> {
  const loaded = await loadEditableShowing(params.interactionId);
  if (!loaded.ok) return loaded;
  const { client, ...showing } = loaded.showing;
  return applyCancellation({ showing, client, actor: params.actor, now: params.now ?? new Date(), reason: params.reason });
}

/**
 * Перенести показ из CRM на новое время. Объект не меняется: смена объекта — это
 * другая договорённость, и заводить её агент будет через обычную форму показа,
 * где видно и подбор, и доступность.
 *
 * `reason` обязателен той же причиной, что у отмены (владелец 16.08.2026).
 */
export async function rescheduleShowingById(params: {
  interactionId: string;
  at: Date;
  actor: ShowingActor;
  reason: string;
  now?: Date;
}): Promise<BookShowingResult | { ok: false; reason: ShowingByIdProblem }> {
  const now = params.now ?? new Date();
  // Переносить в прошлое нельзя: получится встреча, которая просрочена в момент
  // создания, — календарь и напоминания такой уже не помогут.
  if (params.at <= now) return { ok: false, reason: "past" };
  const loaded = await loadEditableShowing(params.interactionId);
  if (!loaded.ok) return loaded;
  const { client, ...showing } = loaded.showing;
  return rescheduleShowing({
    client,
    property: null,
    existing: showing,
    at: params.at,
    actor: params.actor,
    reason: params.reason,
    now,
  });
}

/**
 * Продавцу — отдельная запись в его хронологии о показе ЕГО объекта (пачка 10,
 * 11.09.2026, п.6). Property.sellerClientId — без внешнего ключа (карточка
 * продавца переживает объект), поэтому пишем через updateMany-подобную проверку
 * существования, тем же приёмом, что и закрытие сделки продавцу (routes/deals.ts).
 */
export async function notifySellerOfShowing(
  property: { id: string; title: string; sellerClientId: string | null },
  atLabel: string
): Promise<void> {
  if (!property.sellerClientId) return;
  const seller = await prisma.client.findUnique({
    where: { id: property.sellerClientId },
    select: { id: true, assignedAgentId: true, deletedAt: true },
  });
  if (!seller || seller.deletedAt || !seller.assignedAgentId) return;

  // Автор — system (П-10): назначение показа автоматика зафиксировала сама,
  // продавцу это просто сообщают; subjectAgentId — держатель карточки продавца.
  await logTimeline({
    clientId: seller.id,
    actor: { kind: "system", source: "showingBooking.notifySeller", subjectAgentId: seller.assignedAgentId },
    type: "SYSTEM",
    propertyId: property.id,
    notes: `Показ вашего объекта «${property.title}» назначен на ${atLabel}`,
  });

  await sendPushToAgent(seller.assignedAgentId, {
    title: "👀 Показ объекта продавца",
    body: `«${property.title}» — показ назначен на ${atLabel}`,
    tag: `seller-showing-${property.id}-${atLabel}`,
  }).catch(() => {});
}

/** Код объекта («[код N]» из блока подборки) либо uuid → id в базе. null, если не нашли. */
async function resolvePropertyId(code: number | string | null | undefined): Promise<string | undefined> {
  if (code === null || code === undefined || code === "") return undefined;
  const codeNumber = typeof code === "number" ? code : /^\d+$/.test(String(code)) ? Number(code) : null;
  const property = await prisma.property.findFirst({
    where: codeNumber !== null ? { shortId: codeNumber } : { id: String(code) },
    select: { id: true },
  });
  return property?.id;
}

/**
 * Единая точка входа для канальных обработчиков: назначить, перенести или отменить —
 * решается здесь, а не в каждом мессенджере отдельно.
 *
 * Работает в фоне, не задерживая ответ клиенту: ход бота уже отвечает человеку в
 * мессенджере, а запись показа и push агенту — дело следующих секунд. Сбой не имеет
 * права ронять ход: внутри bookShowing любая неудача заканчивается уведомлением
 * живому человеку, поэтому просьба клиента не пропадает молча даже здесь.
 */
export function applyShowingRequestInBackground(
  clientId: string,
  request: ShowingRequest,
  channel?: string,
  /** Кто на самом деле договорился — см. bookShowing. Без параметра (обычный вызов
   *  из хода самого бота) — как раньше, actor не передаётся и внутри трактуется как
   *  «бот по словам клиента». */
  actor?: ShowingActor
): void {
  if (request.action === "cancel") {
    void cancelShowing({ clientId, propertyCode: request.propertyCode, channel, actor }).catch((err) =>
      console.error("[showing] отмена показа ботом:", err instanceof Error ? err.message : err)
    );
    return;
  }
  // "book" и "reschedule" — один и тот же вызов: что именно произойдёт, решает база
  // (есть ли у клиента живой показ на этот объект), а не слово модели.
  void bookShowing({ clientId, request, channel, actor }).catch((err) =>
    console.error("[showing] назначение показа ботом:", err instanceof Error ? err.message : err)
  );
}

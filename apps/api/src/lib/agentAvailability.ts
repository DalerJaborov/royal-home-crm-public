/**
 * Два разных «агент сейчас не получает лидов»: его собственная пауза и заморозка
 * руководителя.
 *
 * ПОЧЕМУ ЭТО НЕ ОДНО И ТО ЖЕ. Пауза — просьба самого агента («сегодня не могу»):
 * ограничена по времени, включается им же, KPI при этом идёт как обычно. Заморозка —
 * решение руководителя: бессрочна, снимается только руководителем, и KPI замирает.
 * Свалив их в один флаг, мы бы получили либо агента, который сам себя размораживает,
 * либо руководителя, чьё решение истекает само через двое суток.
 *
 * KPI ВО ВРЕМЯ ПАУЗЫ НЕ ОСТАНАВЛИВАЕТСЯ — прямое требование спецификации. Текущие
 * клиенты никуда не делись, и если тумблер обнулял бы просрочки, он мгновенно стал
 * бы способом их прятать: включил на два дня, вернулся с чистым счётом.
 *
 * ЗАМОРОЗКА, НАОБОРОТ, KPI ФИКСИРУЕТ. Замороженному агенту не выдают работу вовсе,
 * и падение счёта означало бы наказание за то, что ему запретили работать.
 */

import { prisma } from "../db.js";

const FALLBACK_MAX_HOURS = 48;
const FALLBACK_COOLDOWN_HOURS = 24;

export interface PauseLimits {
  maxHours: number;
  cooldownHours: number;
}

export async function loadPauseLimits(): Promise<PauseLimits> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { agentPauseMaxHours: true, agentPauseCooldownHours: true },
    });
    return {
      maxHours: s?.agentPauseMaxHours ?? FALLBACK_MAX_HOURS,
      cooldownHours: s?.agentPauseCooldownHours ?? FALLBACK_COOLDOWN_HOURS,
    };
  } catch {
    return { maxHours: FALLBACK_MAX_HOURS, cooldownHours: FALLBACK_COOLDOWN_HOURS };
  }
}

export interface AvailabilityState {
  /** Агент готов получать новые лиды прямо сейчас. */
  available: boolean;
  /** Действующая до этого момента пауза, поставленная самим агентом. */
  pausedUntil: Date | null;
  /** Заморожен руководителем. */
  frozen: boolean;
}

export function availabilityOf(
  agent: { leadsPausedUntil: Date | null; frozenAt: Date | null },
  now = new Date()
): AvailabilityState {
  const pausedUntil =
    agent.leadsPausedUntil && agent.leadsPausedUntil.getTime() > now.getTime() ? agent.leadsPausedUntil : null;
  const frozen = agent.frozenAt !== null;
  return { available: !pausedUntil && !frozen, pausedUntil, frozen };
}

/**
 * Может ли агент включить паузу прямо сейчас.
 *
 * «Остыть» отсчитывается от КОНЦА прошлой паузы, а не от её начала: иначе агент с
 * двухсуточной паузой мог бы включить следующую в ту же минуту, как истекла
 * предыдущая, и пауза стала бы постоянным состоянием.
 */
export function canStartPause(
  agent: { leadsPausedUntil: Date | null; leadsPausedEndedAt: Date | null; frozenAt: Date | null },
  limits: PauseLimits,
  now = new Date()
): { allowed: true } | { allowed: false; reason: string } {
  if (agent.frozenAt) return { allowed: false, reason: "Учётная запись заморожена руководителем" };
  const state = availabilityOf(agent, now);
  if (state.pausedUntil) return { allowed: false, reason: "Пауза уже включена" };

  if (agent.leadsPausedEndedAt) {
    const readyAt = new Date(agent.leadsPausedEndedAt.getTime() + limits.cooldownHours * 3600_000);
    if (readyAt.getTime() > now.getTime()) {
      const hoursLeft = Math.ceil((readyAt.getTime() - now.getTime()) / 3600_000);
      return {
        allowed: false,
        reason: `После прошлой паузы должно пройти ${limits.cooldownHours} ч — осталось ${hoursLeft} ч`,
      };
    }
  }
  return { allowed: true };
}

/** Конец паузы по запрошенной длительности, обрезанной потолком из Настроек. */
export function pauseEndsAt(hours: number, limits: PauseLimits, now = new Date()): Date {
  const capped = Math.min(Math.max(1, Math.round(hours)), limits.maxHours);
  return new Date(now.getTime() + capped * 3600_000);
}

/**
 * АГЕНТА НЕТ НА РАБОТЕ — отпуск, больничный, разбирательство (владелец 08.09.2026).
 *
 * ЗАЧЕМ ОТДЕЛЬНОЕ ПОНЯТИЕ, если рядом уже есть «не получает лидов». Потому что это
 * разные вопросы, и путать их дорого:
 *
 *   ПАУЗА («не принимаю новых лидов») — агент НА МЕСТЕ. Он закрывает своих клиентов
 *   перед отпуском, просто не берёт новых. Все счётчики идут, все тревоги работают.
 *
 *   ЗАМОРОЗКА — агента НЕТ. Требовать от него звонков нельзя, и тревоги «перестал
 *   пытаться» по его карточкам считать нечестно.
 *
 * ЧТО ЭТО ЧИНИТ. До 08.09.2026 про заморозку не знал НИ ОДИН модуль тревог: агент
 * уходил в отпуск, а светофор продолжал слать ему напоминания, его неактивные клиенты
 * досчитывали лимит попыток и уходили в «Потерянные» — автоматически, с начислением
 * ему штрафа. Человек возвращался из отпуска и обнаруживал, что часть портфеля
 * растворилась, а система записала это ему в вину.
 *
 * ЧЕГО ЭТО НЕ ОТКЛЮЧАЕТ. Тревоги про обход CRM (спросил номер, признаки увода,
 * заблокированное голосовое) работают ВСЕГДА, включая отсутствие. Отпуск не делает
 * увод законным — наоборот, это идеальное прикрытие: «я болел, потому и тишина».
 * Выключать их значило бы написать инструкцию «возьми больничный и уводи».
 */
export async function absentAgentIds(): Promise<Set<string>> {
  const rows = await prisma.agent.findMany({
    where: { frozenAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((a) => a.id));
}

/** Тот же вопрос про одного агента. */
export async function isAgentAbsent(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { frozenAt: true } });
  return agent?.frozenAt != null;
}

/**
 * ВИД ОТСУТСТВИЯ — от него зависят сроки передачи вернувшегося клиента
 * (владелец 09.09.2026, см. AbsenceKind в схеме).
 *
 * `null` — агент на месте. Заморожен, но вид не проставлен (так выглядят все, кого
 * заморозили до этой правки) — считаем OTHER: осторожный вариант, при котором
 * клиентов автоматика не отбирает мгновенно.
 */
export async function absenceKindOf(agentId: string): Promise<"VACATION" | "SICK" | "OTHER" | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { frozenAt: true, absenceKind: true },
  });
  if (!agent?.frozenAt) return null;
  return agent.absenceKind ?? "OTHER";
}

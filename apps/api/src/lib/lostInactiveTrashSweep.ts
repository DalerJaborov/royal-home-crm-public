import { dushanbeDayKey } from "@royal-home/shared";
import { prisma } from "../db.js";
import { trashClient } from "./trashClient.js";
import { logSystemError } from "./systemError.js";
import { sendPushToAgent } from "../push.js";

/**
 * «ПОТЕРЯННЫЕ» И «НЕАКТИВНЫЕ» СТАРШЕ 3 МЕСЯЦЕВ → АВТОМАТИЧЕСКИ В КОРЗИНУ
 * (владелец 30.08.2026, дословно: «потерянные и неактивные тоже сделай через
 * 3 месяца пусть уходят в корзину, если будет повторный звонок или сообщение
 * в чате, карточка восстановится со своей историей и заново пройдёт через
 * KPI»). Восстановление по повторному обращению уже работает — см.
 * leads.ts::resumeExistingChannelLead — этот файл его не трогает, только
 * заводит сам переход в Корзину, которого не хватало.
 *
 * Обычное мягкое удаление (lib/trashClient.ts) — та же функция, которой
 * пользуется руководитель руками (DELETE /clients/:id) и одобрение заявки
 * агента: карточка уходит в Корзину (deletedAt), сделки/переписка/диалоги
 * остаются нетронутыми, «Восстановить» возвращает её как была.
 *
 * УСЛОВИЕ (Settings.lostOrInactiveToTrashAfterDays, по умолчанию 90 дней):
 *   status="LOST" И lostAt старше срока,
 *   ИЛИ workStatus="INACTIVE" И inactiveSince старше срока.
 * deletedAt уже отфильтрован в самом запросе — не трогаем уже удалённых.
 *
 * lostAt — НОВОЕ поле (миграция 20260830200000), у карточек, ставших LOST
 * ДО того, как весь код начал его проставлять, оно null и в выборку по LOST
 * не попадёт (см. отчёт агента — все четыре места, пишущие status:"LOST",
 * теперь пишут и lostAt). Исторический бэкфилл lostAt по старым карточкам —
 * отдельное решение владельца, этот файл его не делает: непонятно, какую
 * дату считать «моментом потери» для карточек без записи об этом.
 */

const FALLBACK_TRASH_AFTER_DAYS = 90;
const DAY_MS = 86_400_000;

async function loadTrashAfterDays(): Promise<number> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { lostOrInactiveToTrashAfterDays: true },
    });
    return s?.lostOrInactiveToTrashAfterDays ?? FALLBACK_TRASH_AFTER_DAYS;
  } catch {
    return FALLBACK_TRASH_AFTER_DAYS;
  }
}

/**
 * ОТ ЧЬЕГО ИМЕНИ ДЕЙСТВУЕТ АВТОМАТИКА. В репозитории нет отдельной «системной»
 * учётки для такого рода действий (проверено — ни routes/security.ts, ни
 * остальной код не заводят такой identity; другие кроны, пишущие Interaction
 * от чьего-то имени, всегда берут assignedAgentId конкретной карточки, что
 * здесь не подходит: у Потерянного/Неактивного клиента агент мог уже уйти из
 * компании, а карточка без назначенного агента тоже должна уметь уехать в
 * Корзину). Берём первого АКТИВНОГО агента с ролью ADMIN как исполнителя по
 * умолчанию — deletedById обязан указывать на реального Agent (внешний ключ),
 * и это ближайшая по смыслу роль для административного автоматического
 * действия. Нет ни одного ADMIN — трогать ничего не можем, только пишем в
 * журнал ошибок и выходим (тихо пропускать было бы хуже: карточки просто не
 * поедут в Корзину, и об этом никто не узнает).
 */
async function resolveAutomationAgentId(): Promise<string | null> {
  const admin =
    (await prisma.agent.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } })) ??
    (await prisma.agent.findFirst({ where: { role: "ADMIN" }, select: { id: true } }));
  return admin?.id ?? null;
}

export interface LostInactiveTrashSweepSummary {
  trashed: number;
  skipped: number;
}

/** Запуск раз в сутки (см. cron.ts) — не срочный сигнал. */
export async function runLostInactiveTrashSweep(now: Date = new Date()): Promise<LostInactiveTrashSweepSummary> {
  const afterDays = await loadTrashAfterDays();
  const cutoff = new Date(now.getTime() - afterDays * DAY_MS);

  const candidates = await prisma.client.findMany({
    where: {
      deletedAt: null,
      OR: [
        { status: "LOST", lostAt: { lt: cutoff } },
        { workStatus: "INACTIVE", inactiveSince: { lt: cutoff } },
      ],
    },
    select: { id: true, shortId: true, assignedAgentId: true },
    take: 200,
  });

  if (candidates.length === 0) return { trashed: 0, skipped: 0 };

  const byAgentId = await resolveAutomationAgentId();
  if (!byAgentId) {
    await logSystemError(
      "api",
      `Автоуборка Потерянных/Неактивных в Корзину: нет ни одного активного агента с ролью ADMIN — пропущено кандидатов: ${candidates.length}`
    );
    return { trashed: 0, skipped: candidates.length };
  }

  let trashed = 0;
  let skipped = 0;
  // Держатель → номера ушедших карточек — ОДНА сводка на прогон крона, а не
  // пуш на каждую (18.09.2026, задание В, §f п.3: «сводка держателю, не
  // поштучно»). trashClient сам умеет слать поштучный пуш «удалено не вами»,
  // но за ночь свип мог тронуть десятки карточек одного агента разом.
  const trashedByHolder = new Map<string, number[]>();

  // Последовательно, не Promise.all — trashClient сам гасит требования/просьбы
  // о звонке отдельными запросами на клиента; количество кандидатов за сутки
  // в реальности единицы-десятки (см. lib/dealStalePipeline.ts, тот же приём).
  for (const c of candidates) {
    const result = await trashClient(c.id, byAgentId, { notifyHolder: false });
    if (result.ok) {
      trashed++;
      if (c.assignedAgentId) {
        trashedByHolder.set(c.assignedAgentId, [...(trashedByHolder.get(c.assignedAgentId) ?? []), c.shortId]);
      }
    } else {
      // trashClient отдаёт только 404 (карточка исчезла между выборкой и
      // обработкой — гонка с ручным удалением) и 409 (у карточки нашлась
      // незакрытая, не CANCELLED сделка — например, LOST-продавцу задним
      // числом завели сделку руками). Оба исхода живые, не ошибка автоматики —
      // в журнал не пишем, просто не наш кандидат сегодня.
      skipped++;
    }
  }

  for (const [agentId, shortIds] of trashedByHolder) {
    const codes = shortIds.slice(0, 10).map((id) => `№${id}`).join(", ");
    const more = shortIds.length > 10 ? ` и ещё ${shortIds.length - 10}` : "";
    void sendPushToAgent(agentId, {
      title: `🗑️ Автосвип: ${shortIds.length} ${shortIds.length === 1 ? "карточка" : "карточек"} в Корзине`,
      body: `Потерянные/Неактивные старше срока переведены автоматически: ${codes}${more}`,
      url: "/clients",
      // Сутки — по Душанбе, не по часам процесса (Ф12, 02.10.2026).
      tag: `lost-inactive-sweep-${agentId}-${dushanbeDayKey(now)}`,
    }).catch((err) => {
      void logSystemError(
        "api",
        `Сводный пуш автосвипа не отправлен (держатель ${agentId}): ${err instanceof Error ? err.message : err}`
      );
    });
  }

  return { trashed, skipped };
}

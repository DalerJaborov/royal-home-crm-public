import { dushanbeDayKey } from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { isWithinWorkingHours } from "./workingHours.js";

/**
 * АЛАРМ «У ОДНОГО АГЕНТА МАССОВО УДАЛИЛИ КЛИЕНТОВ» (владелец 16.09.2026: жалоба
 * агента Нозы — «все клиенты пропали, объекты остались»).
 *
 * ЧТО ПОКАЗАЛА ПРОВЕРКА ПО ЭТОМУ СЛУЧАЮ. Данные на проде честные: у Нозы 9 живых
 * карточек (8 покупателей/продавцов + 1 «прочее», не показывается агенту по
 * правилу видимости) и 20 в Корзине. Ни одного JS-краша на /clients в её журнале.
 * 20 удалений растянуты на месяц (17.08–14.09), все одним и тем же админом —
 * это НЕ один мгновенный сбой, а обычная текущая работа руководства по разбору
 * заявок на удаление, которая с точки зрения агента за месяц выглядит как «мои
 * клиенты потихоньку тают», а он видит это только когда портфель опустел заметно.
 *
 * ПОЧЕМУ ЭТОГО СИГНАЛА НЕ БЫЛО. trashClient.ts (единая точка удаления, см. её же
 * комментарий) считает КАЖДОЕ удаление независимым действием руководства — что
 * оно и есть по отдельности. Но подряд идущая серия удалений У ОДНОГО АГЕНТА
 * ничем не отличалась от разового удаления одной карточки: ни счётчика, ни
 * уведомления. agentHandoffAnomalyAlarm.ts считает похожую вещь (передачи/отказы),
 * но по действиям САМОГО агента, а не по тому, что с его портфелем делает
 * руководство.
 *
 * ЧТО СЧИТАЕМ. Сколько карточек ЭТОГО агента ушло в Корзину за последние
 * WINDOW_HOURS часов (включая только что удалённую) — рабочий день или бурная
 * сессия разбора заявок, а не календарный месяц: цель — поймать всплеск, а не
 * посчитать общий темп чистки Корзины.
 *
 * ПОРОГ 5: у Нозы за худший день (27.08) ушло 6 карточек разом — это и есть
 * пример дня, который стоило заметить сразу, а не постфактум через три недели.
 * Порог ниже 5 ловил бы обычную ежедневную работу руководства с заявками на
 * удаление (1-4 в день — обычный темп по её же истории) и быстро надоел бы.
 */
const WINDOW_HOURS = 24;
const ANOMALY_THRESHOLD = 5;

export async function noteClientTrashedAndAlarmIfAnomalous(input: {
  agentId: string;
  client: { id: string; shortId: number; fullName: string };
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const windowStart = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
    const count = await prisma.client.count({
      where: { assignedAgentId: input.agentId, deletedAt: { gte: windowStart, lte: now } },
    });
    if (count < ANOMALY_THRESHOLD) return;

    // Директора не будим ночью — тот же приём, что у agentHandoffAnomalyAlarm.ts:
    // счётчик уже отражён в самих данных (Client.deletedAt) и никуда не денется,
    // следующий рабочий час догонит его тем же tag.
    if (!(await isWithinWorkingHours(now))) return;

    const agent = await prisma.agent.findUnique({ where: { id: input.agentId }, select: { fullName: true } });
    const directorIds = (
      await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } })
    ).map((d) => d.id);
    if (directorIds.length === 0) return;

    // Один tag на агента и календарный день — повторные удаления в том же
    // всплеске схлопываются в одну строку ленты (createNotifications::upsertByTag),
    // а не шлют пуш на каждое следующее удаление сверх порога.
    // Сутки — по Душанбе, не по UTC (Ф12, 02.10.2026).
    const dayTag = dushanbeDayKey(now);
    const tag = `client-trash-anomaly-${input.agentId}-${dayTag}`;
    const payload = {
      kind: "oversight" as const,
      title: `⚠️ У ${agent?.fullName ?? "агента"} за сутки удалено ${count} клиентов`,
      body: `Последняя — «${input.client.fullName}» (№${input.client.shortId}). Если это не плановая чистка Корзины — стоит проверить, что удаления обоснованы.`,
      url: `/team/${input.agentId}`,
      tag,
    };
    await createNotifications(directorIds, payload);
    void sendPushToAgents(directorIds, payload).catch((err) =>
      console.error("[alarm] client-trash-anomaly push:", err)
    );
  } catch (err) {
    // Сигнал руководителю не важнее самого удаления — не роняем trashClient
    // из-за непрочитанного счётчика (тот же приём, что у соседних алармов).
    console.error("[alarm] client-trash-anomaly:", err instanceof Error ? err.message : err);
  }
}

import { prisma } from "../db.js";
import { pickAgentForLead, receiverRingByKpi } from "../leads.js";
import { sendPushToAgent } from "../push.js";
import { cancelPendingClientDeleteRequestOnTransfer } from "./trashClient.js";
import { propertiesOwnedByWhere } from "./propertyHandover.js";
import { transferPropertyWithSeller } from "./propertyTransferWithSeller.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { HandoverSnapshotItems } from "./agentHandoverRevert.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { HANDOVER_ASSIGN_REASON } from "./leadReason.js";

/**
 * Передача дел уходящего сотрудника (примечание владельца от 30.07: «продумать, как
 * передать все ожидания и клиентов агента, если он уйдёт»).
 *
 * До этого при увольнении учётку просто отключали — и клиенты вместе с задачами
 * оставались висеть на человеке, которого в компании больше нет: лиды не отвечали,
 * задачи не выполнялись, а в отчётах всё это продолжало числиться за ним.
 *
 * Что переносится:
 *  - активные клиенты (кроме закрытых сделкой, архивных и удалённых);
 *  - незакрытые задачи по ним («ожидания»: перезвонить, показ, встреча);
 *  - объекты, где уходящий — ХОЗЯИН по правилу propertyOwnerAgentId (принял ??
 *    ведёт ?? завёл), кроме уже проданных, снятых с продажи и лежащих в корзине:
 *    показы, лиды по объекту и переговоры с собственником нужно кому-то продолжать.
 *    До 24.09.2026 смотрели только на `assignedAgentId` — поле, которое на проде
 *    заполнено у 2 объектов из 46, — и объекты уволенных оставались «их»
 *    (подробно — lib/propertyHandover.ts).
 *
 * Что НЕ переносится сознательно:
 *  - сделки. Deal.agentId определяет, кому пойдёт комиссия, — это денежное решение
 *    руководителя, а не следствие увольнения. Открытые сделки возвращаются числом,
 *    чтобы руководитель разобрал их руками;
 *  - уже закрытые сделки по объектам. Хозяин объекта (intakeAgentId — «принял у
 *    собственника», доля 0.5% при БУДУЩЕЙ продаже) с 24.09.2026 ПЕРЕПИСЫВАЕТСЯ на
 *    получателя: владелец решил, что переданный объект — целиком объект нового
 *    агента. Комиссия по уже закрытым сделкам снята снапшотом в Deal и не меняется;
 *  - история взаимодействий. Она фиксирует, кто и что делал, — переписывать прошлое
 *    задним числом нельзя.
 *
 * Новый агент получает клиента как новый лид (acceptedAt = null): он должен принять
 * его сам, иначе у него окажется клиент, о котором он не знает, а таймер ответа по
 * нему уже идёт.
 *
 * КЛИЕНТЫ И ОБЪЕКТЫ РАЗДАЮТСЯ ПО РАЗНЫМ ПРАВИЛАМ (решение владельца 11.08.2026,
 * дословно: «его объекты распределяются между другими агентами начиная с тех у
 * кого низкий KPI, а клиенты (в том числе и горячие) тем у кого высокий KPI
 * (дальше свободный и не в отпуске)»):
 *  - клиенты идут агентам с ВЫСОКИМ Royal Score, горячие — первыми. Клиент это
 *    начатый разговор, его нельзя ставить на паузу, пока новичок разбирается;
 *  - объекты идут агентам с НИЗКИМ Royal Score. Объект это материал для работы,
 *    он ничего не ждёт и нужнее тому, у кого работы мало.
 *
 * ПО ОДНОЙ КАРТОЧКЕ И ПО КРУГУ (владелец 18.09.2026, дословно: «по одному лиду и
 * по кругу, неважно, в каком они разделе, начинаем с сильного»).
 *
 * ЧТО СЛУЧИЛОСЬ ДО ЭТОГО. Все 16 продавцов уволенного сотрудника достались ОДНОМУ
 * агенту. Очередь при этом не сломалась — она отработала ровно как написана:
 * pickNextAgentByKpiQueue сортирует сначала по УРОВНЮ Royal Score (шаг 10 очков) и
 * лишь внутри уровня крутит агентов по кругу. Когда в верхнем уровне один человек,
 * крутить внутри уровня некого, и каждая из 16 итераций выбирает его снова.
 * Пересчёт «на каждом шаге» от этого не спасал: уровень решает раньше кольца.
 *
 * Теперь уровней при раздаче портфеля нет вовсе: получатели выстраиваются по счёту
 * ОДИН раз (receiverRingByKpi), и карточки идут по кругу — по одной каждому.
 * Направление прежнее: клиентам первым сильнейший, объектам первым слабейший.
 * Перелив на следующего получается сам, отдельный потолок «не больше N одному» не
 * нужен — а значит, и нечему разойтись с этим правилом.
 *
 * Оба правила отключаемы в Настройках (handoverClientsToHighKpi /
 * handoverPropertiesToLowKpi): выключенное правило возвращает прежнее поведение —
 * обычное распределение `pickAgentForLead` и для клиентов, и для объектов.
 * Явно выбранный получатель (ручная передача через окно «Передать дела»)
 * перекрывает оба правила: раз руководитель назвал человека — спорить не с чем.
 */
export interface HandoverResult {
  clients: number;
  tasks: number;
  /** Открытые сделки уходящего — их руководитель разбирает вручную. */
  openDeals: number;
  /** Объекты, где уходящий был ответственным риелтором и которые ещё в работе. */
  properties: number;
  /** Кому что ушло: id агента → сколько клиентов/объектов (для отчёта в интерфейсе). */
  byAgent: { agentId: string; fullName: string; clients: number; properties: number }[];
  /** Клиенты, которым не нашлось агента (некому передать). */
  unassigned: number;
  /** Снимок раздачи для «Вернуть всё как было» (lib/agentHandoverRevert.ts); null — нечего было передавать. */
  batchId: string | null;
}

const MOVABLE_STATUSES = ["NEW", "CONTACTED", "HOT", "COLD", "UNRESPONSIVE"] as const;

/** Запись клиента при передаче дел не состоялась — откатить перенос его задач (B15). */
class HandoverClientRefused extends Error {}

export async function handoverAgentWork(
  fromAgentId: string,
  toAgentId?: string,
  actorId?: string | null
): Promise<HandoverResult> {
  const clients = await prisma.client.findMany({
    where: {
      assignedAgentId: fromAgentId,
      deletedAt: null,
      status: { in: [...MOVABLE_STATUSES] },
    },
    select: { id: true, shortId: true, fullName: true, status: true, hotSince: true, createdAt: true, acceptedAt: true, assignedAt: true },
  });

  // Снимок «что кому ушло и каким было» — для кнопки «Вернуть всё как было»
  // (lib/agentHandoverRevert.ts). Собирается по ходу раздачи, пишется одной
  // записью в конце; без раздачи (нечего передавать) записи нет.
  const snapshot: HandoverSnapshotItems = { clients: [], tasks: [], properties: [] };
  const propertySnapshotSelect = {
    id: true,
    intakeAgentId: true,
    assignedAgentId: true,
    createdById: true,
    handoverPendingSince: true,
    handoverFromAgentId: true,
    handoverReason: true,
  } as const;
  const snapProperty = (
    p: { id: string; intakeAgentId: string | null; assignedAgentId: string | null; handoverPendingSince: Date | null; handoverFromAgentId: string | null; handoverReason: string | null },
    targetId: string
  ) =>
    snapshot.properties.push({
      propertyId: p.id,
      toAgentId: targetId,
      intakeAgentId: p.intakeAgentId,
      assignedAgentId: p.assignedAgentId,
      handoverPendingSince: p.handoverPendingSince?.toISOString() ?? null,
      handoverFromAgentId: p.handoverFromAgentId,
      handoverReason: p.handoverReason,
    });

  // ГОРЯЧИЕ ПЕРВЫМИ. Получателя мы считаем заново на КАЖДОМ клиенте, и первые в
  // списке достаются самым сильным агентам — очередь по KPI ещё не сдвинулась
  // кольцом. Раньше порядок приходил из БД произвольным, и горячий клиент — тот,
  // кто уже отказал одному агенту и потому сложнее любого нового, — мог достаться
  // кому попало. Горячим считаем и по статусу, и по hotSince: статус HOT ставит
  // агент руками, hotSince — система при отказе, и одно без другого встречается.
  const hotRank = (c: { status: string; hotSince: Date | null }) => (c.status === "HOT" || c.hotSince ? 0 : 1);
  clients.sort(
    (a, b) =>
      hotRank(a) - hotRank(b) ||
      (b.hotSince?.getTime() ?? 0) - (a.hotSince?.getTime() ?? 0) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );

  // ВСЕ объекты, где уходящий — хозяин по правилу propertyOwnerAgentId (принял ??
  // ведёт ?? завёл), а не только `assignedAgentId` (24.09.2026: у уволенной
  // сотрудницы 4 объекта в работе, отчёт «объектов: 0» — подробно в
  // lib/propertyHandover.ts).
  const properties = await prisma.property.findMany({
    where: propertiesOwnedByWhere(fromAgentId),
    select: { id: true, shortId: true, title: true },
    orderBy: { createdAt: "asc" },
  });

  const openDeals = await prisma.deal.count({
    where: { agentId: fromAgentId, stage: { notIn: ["COMPLETED", "CANCELLED"] } },
  });

  if (clients.length === 0 && properties.length === 0) {
    return { clients: 0, tasks: 0, openDeals, properties: 0, byAgent: [], unassigned: 0, batchId: null };
  }

  // Рубильники из Настроек: выключенное правило обязано вернуть ровно прежнее
  // поведение — обычное распределение и для клиентов, и для объектов.
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { handoverClientsToHighKpi: true, handoverPropertiesToLowKpi: true },
  });
  const clientsToHighKpi = settings?.handoverClientsToHighKpi ?? true;
  const propertiesToLowKpi = settings?.handoverPropertiesToLowKpi ?? true;

  // Имя актора — одним запросом до цикла (22.09.2026, сведение N+1): обе
  // ручки, откуда зовётся handoverAgentWork («Передача дел» и увольнение),
  // всегда передают actorId, и он один и тот же на КАЖДОЙ карточке цикла ниже —
  // без этого changeClientAgent читала бы его заново на каждого клиента.
  const actorName = actorId ? ((await prisma.agent.findUnique({ where: { id: actorId }, select: { fullName: true } }))?.fullName ?? "Неизвестно") : undefined;
  // Причину получатель читает перед тем, как принять объект, — с именем ушедшего:
  // «от кого» ему важнее, чем «по какому правилу раздали».
  const fromAgent = await prisma.agent.findUnique({ where: { id: fromAgentId }, select: { fullName: true } });
  const propertyHandoverReason = toAgentId
    ? `${fromAgent?.fullName ?? "Сотрудник"} уходит из компании — объекты переданы вам руководителем.`
    : `${fromAgent?.fullName ?? "Сотрудник"} уходит из компании — объекты распределены по команде${propertiesToLowKpi ? ", начиная с агентов с низким Royal Score" : ""}.`;

  const clientsByAgent = new Map<string, number>();
  const propertiesByAgent = new Map<string, number>();
  let movedClients = 0;
  let movedTasks = 0;
  let movedProperties = 0;
  let unassigned = 0;

  /**
   * Кольца строятся ДО раздачи и по одному разу: круговая выдача тем и отличается
   * от прежнего пересчёта на каждом шаге, что порядок известен заранее и каждый
   * получатель отстоит от себя же ровно на длину круга. Клиентам — от сильного,
   * объектам — от слабого; круги независимы, и объект не сдвигает очередь клиентов.
   * Раздавать нечего — кольцо не строим вовсе, лишнего запроса в базу нет. Пустое
   * кольцо (все в отпуске, заморожены, на паузе) оставляет карточки без агента,
   * как и прежде: unassigned.
   */
  const clientRing =
    toAgentId || !clientsToHighKpi || clients.length === 0 ? [] : await receiverRingByKpi([fromAgentId], "desc");
  const propertyRing =
    toAgentId || !propertiesToLowKpi || properties.length === 0 ? [] : await receiverRingByKpi([fromAgentId], "asc");
  let clientTurn = 0;
  let propertyTurn = 0;

  for (const client of clients) {
    // Явный получатель перекрывает любое правило. Без него — круг по Royal Score
    // сверху (клиент это начатый разговор, его ведёт сильный), а с выключенным
    // рубильником прежнее обычное распределение: оно уже умеет и лимит активных
    // лидов, и стратегию из Настроек.
    const targetId =
      toAgentId ??
      (clientsToHighKpi
        ? (clientRing[clientTurn++ % clientRing.length] ?? null)
        : await pickAgentForLead(fromAgentId));
    if (!targetId) {
      unassigned++;
      continue;
    }

    // Клиент и его незакрытые задачи переезжают одной транзакцией: клиент у нового
    // агента, а задачи по нему у старого — худший из возможных промежуточных исходов.
    // Объекты продавца, что уедут вместе с ним (связка), — в снимок ДО записи.
    const sellerProps = await prisma.property.findMany({
      where: { ...propertiesOwnedByWhere(fromAgentId), sellerClientId: client.id },
      select: propertySnapshotSelect,
    });
    const tasks = await prisma.$transaction(async (tx) => {
      const taskSnapshot: typeof snapshot.tasks = [];
      const ownWhere = { clientId: client.id, agentId: fromAgentId, nextAction: { not: null }, completedAt: null };
      const autoWhere = { clientId: client.id, agentId: null, subjectAgentId: fromAgentId, nextAction: { not: null }, completedAt: null };
      const ownIds = await tx.interaction.findMany({ where: ownWhere, select: { id: true } });
      const autoIds = await tx.interaction.findMany({ where: autoWhere, select: { id: true } });
      const t = await tx.interaction.updateMany({ where: ownWhere, data: { agentId: targetId } });
      // Задачи, заведённые на уходящего ботом, ИИ или системой (agentId пуст,
      // адресат — subjectAgentId, П-10), — туда же (23.09.2026): иначе показ,
      // назначенный ботом, оставался за уволенным, и новый агент о нём не знал.
      const auto = await tx.interaction.updateMany({ where: autoWhere, data: { subjectAgentId: targetId } });
      t.count += auto.count;
      for (const { id } of ownIds) taskSnapshot.push({ interactionId: id, field: "agentId", toAgentId: targetId });
      for (const { id } of autoIds) taskSnapshot.push({ interactionId: id, field: "subjectAgentId", toAgentId: targetId });
      const changed = await changeClientAgent({
        clientId: client.id,
        toAgentId: targetId,
        reason: "Клиент передан из дел уходящего сотрудника вместе с незакрытыми задачами",
        actorId: actorId ?? null,
        actorName,
        interactionAgentId: targetId,
        source: "handover",
        /**
         * ПРИНЯТ СРАЗУ (B7, решение владельца 02.10.2026). Портфель передаёт
         * руководитель — решение уже принял человек. Раньше клиент приходил
         * непринятым: через 15 минут карусель разносила его другим, а
         * получателя штрафовали «не принял». Причина «передача дел» снимает
         * и окно «первый звонок за 15 минут» (services/leads/firstCall.ts).
         */
        data: { assignedAt: new Date(), acceptedAt: new Date(), assignReason: HANDOVER_ASSIGN_REASON },
        tx,
      });
      /**
       * КЛИЕНТ НЕ ПЕРЕЕХАЛ — ЕГО ЗАДАЧИ ТОЖЕ (B15, 02.10.2026). Запись клиента
       * могла не состояться (карточку в ту же секунду отправили в Корзину, закон
       * запретил передачу) — тогда перенос задач выше откатывается вместе с
       * транзакцией, иначе задачи уезжали получателю, а клиент оставался прежним.
       */
      if (!changed.ok) throw new HandoverClientRefused();
      return { ...t, properties: changed.properties ?? 0, taskSnapshot };
    }).catch((err: unknown) => {
      if (err instanceof HandoverClientRefused) return null;
      throw err;
    });
    if (!tasks) {
      unassigned++;
      continue;
    }
    snapshot.tasks.push(...tasks.taskSnapshot);

    movedClients++;
    movedTasks += tasks.count;
    clientsByAgent.set(targetId, (clientsByAgent.get(targetId) ?? 0) + 1);
    snapshot.clients.push({
      clientId: client.id,
      toAgentId: targetId,
      acceptedAt: client.acceptedAt?.toISOString() ?? null,
      assignedAt: client.assignedAt?.toISOString() ?? null,
    });
    // Объекты продавца уехали вместе с ним (связка 24.09.2026) — к тому же
    // агенту, а не по своему кольцу: продавец и его дом не должны разъехаться.
    if (tasks.properties > 0) {
      movedProperties += tasks.properties;
      propertiesByAgent.set(targetId, (propertiesByAgent.get(targetId) ?? 0) + tasks.properties);
      for (const p of sellerProps) snapProperty(p, targetId);
    }

    /**
     * Разведка 07.09.2026 (класс «осиротевшие спутники»): раздача дел уволенного
     * НЕ трогала PendingSummary/ClientDeleteRequest вовсе — в отличие от ручной
     * передачи (lib/clientTransfer.ts) и заморозки (routes/agents.ts), у которых
     * этот шаг уже был. Открытые требования оставались висеть на учётке, которую
     * только что отключили (или подготовили к отключению), продолжая считаться
     * долгом при выдаче лидов и штрафовать за просрочку — а заявка на удаление
     * рисковала стереть карточку из-под нового агента, который о ней не знает.
     * Best-effort: раздача уже состоялась (клиент передан), гашение сателлитов
     * не должно откатывать саму передачу, если споткнётся.
     */
    await cancelPendingClientDeleteRequestOnTransfer(
      client.id,
      "Сотрудник уволен, клиент передан другому агенту — заявка снята автоматически"
    );
  }

  // Что осталось после продавцов: объекты без продавца или с продавцом у другого
  // агента — их раздаём по кольцу. Выборка ЗАНОВО: часть объектов только что
  // уехала вместе со своими продавцами.
  const propertiesLeft = await prisma.property.findMany({
    where: propertiesOwnedByWhere(fromAgentId),
    select: { ...propertySnapshotSelect, shortId: true, title: true, sellerClientId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const property of propertiesLeft) {
    // Здесь круг ПЕРЕВЁРНУТЫЙ: первым объект достаётся агенту с низким Royal Score —
    // ему не хватает материала для работы, а объект, в отличие от клиента, никого
    // не заставляет ждать. Явный получатель по-прежнему главнее, выключенный
    // рубильник возвращает прежнее обычное распределение.
    const targetId =
      toAgentId ??
      (propertiesToLowKpi
        ? (propertyRing[propertyTurn++ % propertyRing.length] ?? null)
        : await pickAgentForLead(fromAgentId));
    if (!targetId) {
      unassigned++;
      continue;
    }

    // Тем же механизмом, что и ручная передача из карточки (lib/propertyHandover.ts):
    // оба поля хозяина, отметка «передан вам, примите», след в журнале, снятие
    // чужой заявки на удаление. Пуш получателю — один сводный, ниже.
    // Продавец, который уедет за объектом (связка), — в снимок ДО записи.
    const seller = property.sellerClientId
      ? await prisma.client.findUnique({
          where: { id: property.sellerClientId },
          select: { id: true, acceptedAt: true, assignedAt: true },
        })
      : null;
    const moved = await transferPropertyWithSeller({
      propertyId: property.id,
      toAgentId: targetId,
      reason: propertyHandoverReason,
      actorId: actorId ?? null,
      actorName,
      source: "handover",
      notify: false,
    });
    if (!moved.changed) continue;

    movedProperties++;
    propertiesByAgent.set(targetId, (propertiesByAgent.get(targetId) ?? 0) + 1);
    snapProperty(property, targetId);
    if (moved.sellerMoved && seller) {
      movedClients++;
      clientsByAgent.set(targetId, (clientsByAgent.get(targetId) ?? 0) + 1);
      snapshot.clients.push({
        clientId: seller.id,
        toAgentId: targetId,
        acceptedAt: seller.acceptedAt?.toISOString() ?? null,
        assignedAt: seller.assignedAt?.toISOString() ?? null,
      });
    }
  }

  // Снимок раздачи — одной записью: по нему работает «Вернуть всё как было».
  const batch =
    snapshot.clients.length + snapshot.tasks.length + snapshot.properties.length > 0
      ? await prisma.agentHandoverBatch.create({
          data: {
            fromAgentId,
            actorId: actorId ?? null,
            toAgentId: toAgentId ?? null,
            clients: movedClients,
            tasks: movedTasks,
            properties: movedProperties,
            items: snapshot as unknown as Prisma.InputJsonObject,
          },
          select: { id: true },
        })
      : null;

  const receiverIds = new Set([...clientsByAgent.keys(), ...propertiesByAgent.keys()]);
  const receivers = await prisma.agent.findMany({
    where: { id: { in: [...receiverIds] } },
    select: { id: true, fullName: true },
  });

  // Уведомляем получателей: клиенты и объекты пришли не от них самих, и без push
  // человек узнает о них, только случайно открыв список.
  for (const agentId of receiverIds) {
    const clientCount = clientsByAgent.get(agentId) ?? 0;
    const propertyCount = propertiesByAgent.get(agentId) ?? 0;
    const parts = [
      clientCount > 0 ? `клиентов: ${clientCount}` : null,
      propertyCount > 0 ? `объектов: ${propertyCount}` : null,
    ].filter(Boolean);
    void sendPushToAgent(agentId, {
      title: `🤝 Вам передано ${parts.join(", ")}`,
      // Клиенты приходят уже принятыми (B7, 02.10.2026) — принимать их не нужно,
      // объекты по-прежнему принимаются в карточках.
      body: "Сотрудник ушёл — его дела перешли вам. Клиенты уже ваши, они в списке; переданные объекты примите в их карточках.",
      url: clientCount > 0 ? "/clients" : "/properties",
      tag: `handover-${agentId}`,
    }).catch(() => {});
  }

  return {
    clients: movedClients,
    tasks: movedTasks,
    openDeals,
    properties: movedProperties,
    unassigned,
    batchId: batch?.id ?? null,
    byAgent: [...receiverIds].map((agentId) => ({
      agentId,
      fullName: receivers.find((r) => r.id === agentId)?.fullName ?? "—",
      clients: clientsByAgent.get(agentId) ?? 0,
      properties: propertiesByAgent.get(agentId) ?? 0,
    })),
  };
}

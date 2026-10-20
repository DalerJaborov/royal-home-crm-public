import { prisma } from "../db.js";
import { closeClientSatellites } from "./clientSatellites.js";
import { logSystemError } from "./systemError.js";
import { publishClientUpdated } from "./livePublish.js";
import { closeLeadPushNotification, sendPushToAgent } from "../push.js";
import { closeNotifications } from "./notifications.js";
import { noteClientTrashedAndAlarmIfAnomalous } from "./clientTrashAnomalyAlarm.js";

/**
 * УДАЛЕНИЕ КЛИЕНТА В КОРЗИНУ — ОДНА ФУНКЦИЯ НА ВСЕ ВХОДЫ.
 *
 * Входов стало два: прямое DELETE /clients/:id (руководство удаляет само) и
 * одобрение заявки агента (POST /clients/delete-requests/:id/approve,
 * решение владельца 30.08.2026). Оставить логику в теле маршрута значило бы
 * повторить её во втором месте — и повторение почти наверняка забыло бы гашение
 * требований и просьб о звонке. Это не гипотеза: ровно из-за незакрытых
 * требований 27.08.2026 окно «Как прошёл звонок» по УДАЛЁННОМУ клиенту всплывало
 * у агента ещё полчаса, он дважды отложил его и закрыл руками.
 *
 * Мягкое удаление: карточка уходит в Корзину (deletedAt), сделки/переписка/
 * диалоги остаются нетронутыми — «Восстановить» возвращает её как была.
 * Любая сделка кроме CANCELLED блокирует удаление: COMPLETED входит в
 * бухгалтерию и KPI, а рабочие стадии (переговоры/договор) молча исчезли бы с
 * канбана. Физическое удаление — отдельно, DELETE /:id/permanent.
 *
 * Запись в журнал (logAudit) остаётся у вызывающего: ей нужен req, а здесь его
 * нет. Все поля для неё возвращаются в `client`.
 */
export type TrashClientResult =
  | {
      ok: true;
      client: { id: string; shortId: number; fullName: string; phone: string; kind: string };
    }
  | { ok: false; status: 404 | 409; error: string };

export interface TrashClientOptions {
  /** Background retention must still match the state it inspected. */
  guardWhere?: Record<string, unknown>;
  /**
   * false — вызывающая сторона сама уведомит держателя, обычно ОДНОЙ сводкой
   * на пачку карточек, а не поштучным пушем на каждую (см.
   * lib/lostInactiveTrashSweep.ts: автосвип за ночь мог тронуть десятки
   * карточек сразу, и поштучный пуш ниже засыпал бы держателя копиями одного
   * и того же события). По умолчанию true — обычное ручное удаление и
   * одобрение заявки уведомляют сами, как и раньше.
   */
  notifyHolder?: boolean;
}

/**
 * ПОЧЕМУ КАРТОЧКУ НЕЛЬЗЯ УБРАТЬ В КОРЗИНУ — проверка БЕЗ записи (02.10.2026).
 *
 * Вынесена из trashClient, чтобы вызывающие, которые до удаления сами что-то
 * меняют, могли спросить заранее и отказать, НИЧЕГО не тронув. Живой случай —
 * «В кандидаты» (lib/clientToCandidate.ts): анкета создавалась и агент снимался
 * ДО того, как trashClient отказывал по открытой сделке, и клиент со сделкой
 * оставался без агента, а каждое повторное нажатие плодило ещё одну анкету.
 *
 * null — препятствий нет. `db` — чужая открытая транзакция, если она есть.
 */
export async function trashBlocker(
  clientId: string,
  db: { deal: typeof prisma.deal; property: typeof prisma.property } = prisma
): Promise<{ status: 409; error: string } | null> {
  const openDeal = await db.deal.findFirst({
    where: { clientId, stage: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (openDeal) {
    return { status: 409, error: "У клиента есть активная сделка — сначала отмените/завершите её" };
  }

  /**
   * У ПРОДАВЦА ЕСТЬ ОБЪЕКТЫ В РАБОТЕ — УДАЛЯТЬ КАРТОЧКУ НЕЛЬЗЯ (владелец 09.09.2026).
   *
   * Раньше проверялись только сделки, и карточку продавца можно было удалить, пока
   * его объект стоит на сайте и продаётся: объект оставался без владельца, а номер
   * собственника уезжал в Корзину вместе с карточкой.
   *
   * ПОЧЕМУ ЗАПРЕЩАЕМ, А НЕ ПОДЧИЩАЕМ МОЛЧА. Снять объекты автоматически заманчиво,
   * но вместе с ними пропадёт ПРИЧИНА снятия — а именно она наш единственный
   * автоматический вход в проверку СБ («продан в обход агентства»,
   * lib/sellerRefusalReview.ts). Пусть агент снимет каждый объект с причиной, и
   * только после этого карточку можно удалить: тогда цепочка антифрода
   * обязательна, а не зависит от того, каким путём удаляли клиента.
   *
   * sellerClientId — строка без внешнего ключа (см. схему), поэтому ищем по ней,
   * а не по связи.
   */
  const objectsInWork = await db.property.findMany({
    where: {
      sellerClientId: clientId,
      deletedAt: null,
      status: { notIn: ["SOLD", "WITHDRAWN"] },
    },
    select: { shortId: true },
    take: 20,
  });
  if (objectsInWork.length > 0) {
    const list = objectsInWork.map((p) => `№${p.shortId}`).join(", ");
    return {
      status: 409,
      error: `У продавца есть объекты в работе (${list}) — сначала снимите их с продажи, указав причину`,
    };
  }
  return null;
}

export async function trashClient(
  clientId: string,
  byAgentId: string,
  options: TrashClientOptions = {}
): Promise<TrashClientResult> {
  const notifyHolder = options.notifyHolder ?? true;
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt) return { ok: false, status: 404, error: "Клиент не найден" };

  const blocker = await trashBlocker(client.id);
  if (blocker) return { ok: false, ...blocker };

  const updated = await prisma.client.updateMany({
    where: { id: client.id, deletedAt: null, assignedAgentId: client.assignedAgentId, ...options.guardWhere },
    data: {
      deletedAt: new Date(),
      deletedById: byAgentId,
      // Реактивация к прежнему агенту (разбор 31.08.2026, п.12): кто вёл
      // карточку последним, пока не потёрлось при уходе в Корзину —
      // читает intake.ts, когда клиент напишет снова.
      ...(client.assignedAgentId ? { lastAgentId: client.assignedAgentId } : {}),
    },
  });
  if (updated.count !== 1) return { ok: false, status: 409, error: "Карточка изменилась — обновите её перед удалением" };

  /**
   * ПРОВЕРКИ ДУБЛЯ К ЭТОЙ КАРТОЧКЕ ИСТЕКАЮТ СЕЙЧАС (B2 глубокой проверки 02.10.2026).
   * Новая заявка, придержанная вопросом «это ваш клиент?» к удаляемой карточке,
   * иначе ждала бы до шести часов, а подтверждение увело бы её в Корзину вслед за
   * этой. Срок «сейчас» — и ближайший тик раздачи (sweepExpiredDuplicateReviews)
   * отпускает её в обычную раздачу тем же путём, что и любую просроченную проверку.
   */
  await prisma.client.updateMany({
    where: { duplicateReviewOfClientId: client.id, deletedAt: null, duplicateReviewDueAt: { not: null } },
    data: { duplicateReviewDueAt: new Date() },
  });

  // Задачи (nextAction) гасить не нужно: они и так отфильтрованы по
  // `client.deletedAt` одним условием на всю CRM (см. lib/tasks.ts, TASK_WHERE).
  // Просьбы о звонке гасим явно: иначе крон автопрозвона звонил бы удалённому
  // клиенту. (Требований-окон здесь больше нет — механизм удалён 13.09.2026.)
  await closeClientSatellites(client.id);

  /**
   * УВЕДОМЛЕНИЯ И ПУШИ О ЛИДЕ ГАСНУТ ВМЕСТЕ С КАРТОЧКОЙ (правка 15.09.2026,
   * тот же класс, что и живой случай с принятием удалённого клиента).
   *
   * Тот же приём, что при передаче владения (ownershipSatellites.ts,
   * closeOwnershipSatellites): гасим OS-баннер «🔔 Новый лид» у последнего
   * держателя и помечаем read=true строку в его колокольчике по этой
   * карточке — иначе у людей остаются живые уведомления на мёртвые карточки
   * (клик по ним вёл на 404, «Клиент не найден»). Best-effort в своих
   * try/catch, как у соседних шагов: ни один сбой здесь не должен отменить
   * само удаление.
   */
  if (client.assignedAgentId) {
    try {
      await closeLeadPushNotification(client.assignedAgentId, `lead-${client.id}`);
    } catch (err) {
      void logSystemError(
        "api",
        `Пуш «новый лид» не закрыт при удалении карточки (${client.id}, агент ${client.assignedAgentId}): ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      await closeNotifications(
        client.assignedAgentId,
        { clientId: client.id, clientShortId: client.shortId },
        "Карточка удалена в Корзину"
      );
    } catch (err) {
      void logSystemError(
        "api",
        `Уведомления по клиенту не закрыты при удалении карточки (${client.id}): ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * ЗАЯВКА АГЕНТА НА УДАЛЕНИЕ ЗАКРЫВАЕТСЯ ВМЕСТЕ С КАРТОЧКОЙ (07.09.2026, живой
   * случай: Продавец №0127; сохранено при слиянии с рефакторингом
   * closeClientSatellites — та функция про requirements/callbacks, эта про сами
   * заявки, они не пересекаются).
   *
   * Агент отправил карточку на удаление, админ к этому моменту удалил её сам —
   * заявка осталась PENDING и повисла в Корзине красной строкой «Клиент не
   * найден». Разобрать её было нечем: «Удалить в корзину» упиралась в тот же
   * отказ (карточка уже удалена), а «Отклонить» соврала бы агенту — он просил
   * удалить, и карточка удалена.
   *
   * Закрываем как APPROVED, а не REJECTED: с точки зрения агента заявка
   * исполнена. Кто удалил — записываем того, кто удаляет сейчас.
   */
  await prisma.clientDeleteRequest
    .updateMany({
      where: { clientId: client.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        decidedById: byAgentId,
        decidedAt: new Date(),
        decisionNote: "Карточка удалена в Корзину",
      },
    })
    .catch((err) => {
      void logSystemError(
        "api",
        `Заявки на удаление удалённого клиента не закрыты (${client.id}): ${err instanceof Error ? err.message : err}`
      );
      return { count: 0 };
    });

  // Живое обновление ПОСЛЕ записи (аудит 11.09.2026, второй заход по
  // осиротевшим спутникам, п.4 задания): карточка ушла в Корзину — исполнитель
  // должен увидеть, что она исчезла из его списков, без перезагрузки.
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId] });

  // Всплеск удалений у ОДНОГО агента — сигнал руководителю, а не только
  // запись в Корзину (владелец 16.09.2026, жалоба «у Нозы все клиенты
  // пропали»: 20 удалений за месяц накопились незаметно). Best-effort, после
  // самого удаления — не должно повлиять на успех операции.
  if (client.assignedAgentId) {
    void noteClientTrashedAndAlarmIfAnomalous({
      agentId: client.assignedAgentId,
      client: { id: client.id, shortId: client.shortId, fullName: client.fullName },
    });
  }

  /**
   * УДАЛЕНИЕ НЕ СВОЕЙ РУКОЙ — ДЕРЖАТЕЛЬ УЗНАЁТ (18.09.2026, задание В, Р-2:
   * «уведомление на каждый уход»). До сих пор у держателя карточки не было ни
   * пуша, ни строки в ленте — карточка просто переставала находиться (§b п.1
   * разведки 17.09: «Корзина молча... у одного агента 20 карточек в Корзине за
   * месяц одним админом»). Собственное удаление руками (`byAgentId ===
   * assignedAgentId`, агент сам отправил в Корзину) не уведомляем — это не
   * тихий уход, а его собственное действие.
   */
  if (notifyHolder && client.assignedAgentId && client.assignedAgentId !== byAgentId) {
    const actor = await prisma.agent.findUnique({ where: { id: byAgentId }, select: { fullName: true } });
    void sendPushToAgent(client.assignedAgentId, {
      title: "🗑️ Карточка удалена не вами",
      body: `${client.fullName} — в Корзине${actor?.fullName ? ` (${actor.fullName})` : ""}`,
      url: "/clients",
      tag: `client-trashed-${client.id}`,
    }).catch((err) => {
      void logSystemError(
        "api",
        `Пуш о чужом удалении карточки не отправлен (${client.id}, держатель ${client.assignedAgentId}): ${err instanceof Error ? err.message : err}`
      );
    });
  }

  return {
    ok: true,
    client: {
      id: client.id,
      shortId: client.shortId,
      fullName: client.fullName,
      phone: client.phone,
      kind: client.kind,
    },
  };
}

/**
 * ЗАЯВКА НА УДАЛЕНИЕ СНИМАЕТСЯ ПРИ ПЕРЕДАЧЕ КЛИЕНТА ДРУГОМУ АГЕНТУ (07.09.2026,
 * разведка «осиротевшие спутники»).
 *
 * Заявка отражает мнение ПРЕЖНЕГО агента, что клиента пора удалить. Как только
 * клиента забрал другой человек — ручной передачей (lib/clientTransfer.ts) или
 * раздачей дел уволенного (lib/agentHandover.ts) — решение руководства по старой
 * заявке оторвано от реальности: approve стёр бы карточку из-под нового агента,
 * который о заявке даже не знает и, возможно, уже начал работать с клиентом.
 *
 * REJECTED, а не оставить висеть: с точки зрения процесса вопрос решён иначе —
 * клиента оставили в работе, закрепив за другим агентом, а не удалили.
 * decidedById: null — решение приняла сама передача, а не человек.
 *
 * Best-effort, после самой передачи — тот же приём, что у closeClientSatellites.
 */
export async function cancelPendingClientDeleteRequestOnTransfer(
  clientId: string,
  reason: "Клиент передан другому агенту — заявка снята автоматически" | "Сотрудник уволен, клиент передан другому агенту — заявка снята автоматически" = "Клиент передан другому агенту — заявка снята автоматически"
): Promise<void> {
  await prisma.clientDeleteRequest
    .updateMany({
      where: { clientId, status: "PENDING" },
      data: { status: "REJECTED", decidedById: null, decidedAt: new Date(), decisionNote: reason },
    })
    .catch((err) => {
      void logSystemError(
        "api",
        `Заявка на удаление не снята при передаче клиента (${clientId}): ${err instanceof Error ? err.message : err}`
      );
    });
}

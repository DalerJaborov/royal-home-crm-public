import { prisma } from "../db.js";
import { closeLeadPushNotification } from "../push.js";
import { closeNotifications } from "./notifications.js";
import { cancelPendingClientDeleteRequestOnTransfer } from "./trashClient.js";
import { publishClientUpdated } from "./livePublish.js";
import { logSystemError } from "./systemError.js";

/**
 * ГАШЕНИЕ СПУТНИКОВ ВЛАДЕНИЯ — ОДНО МЕСТО НА ВСЕ ПУТИ СМЕНЫ АГЕНТА
 * (11.09.2026, второй заход по осиротевшим спутникам, `docs/archive/agent-briefs/ownership-security-11-09.md`,
 * Пачка 15).
 *
 * ПОЧЕМУ ЭТО ПОНАДОБИЛОСЬ. `lib/changeClientAgent.ts` — единственная точка
 * записи в `Client.assignedAgentId`, но она пишет только поле + Interaction +
 * AuditLog. «Спутников» (пуш, строка в колокольчике, требование «итог»,
 * заявка на удаление, открытая задача, живое обновление экрана) каждый
 * вызывающий код гасил сам — и почти никто не гасил всё сразу. Факт с прода
 * 11.09.2026: из 97 непрочитанных уведомлений «лид» 78 висели у агентов, у
 * которых клиента уже нет; 15 открытых задач — на агентах, не ведущих клиента.
 *
 * ЧТО ДЕЛАЕТ:
 *  - гасит OS-баннер («🔔 Новый лид») у прежнего агента (closeLeadPushNotification);
 *  - помечает read=true строки в его ленте-колокольчике по этому клиенту (closeNotifications);
 *  - перевешивание требований «итог» убрано 14.09.2026 вместе с механизмом окон;
 *  - снимает зависшую заявку прежнего агента на удаление клиента
 *    (cancelPendingClientDeleteRequestOnTransfer) — по `fromAgentId !== toAgentId`,
 *    НЕ по `agentChanged`: владелец может появиться и из пустого поля (оффер
 *    реактивации), это тоже реальная смена (18.09.2026, см. комментарий у вызова);
 *  - переносит открытые задачи (Interaction с nextActionDate, completedAt=null)
 *    на нового агента, либо помечает их в notes, если получателя нет;
 *  - публикует `client.updated` ПОСЛЕ всего перечисленного, чтобы экраны
 *    обоих агентов обновились одним и тем же событием.
 *
 * КОГДА fromAgentId === toAgentId (агент не меняется, например markClientLost):
 * задачи не переносятся и заявка на удаление не трогается (незачем — владелец
 * тот же), но пуш и уведомления «лид» всё равно гасятся (клиент ушёл в LOST —
 * предложение принять лид больше не актуально), и live-событие всё равно
 * публикуется, чтобы статус на экране обновился.
 *
 * BEST-EFFORT, ЗНАЧЕНИЕ ВНЕ ТРАНЗАКЦИИ. Каждый шаг обёрнут catch: ни один из
 * них не должен уронить саму передачу клиента (та же дисциплина, что у
 * `closeClientSatellites`/`cancelPendingClientDeleteRequestOnTransfer`).
 * Вызывать её нужно ПОСЛЕ коммита операции, менявшей `assignedAgentId` —
 * иначе живое событие могло бы прилететь раньше, чем откатится транзакция.
 */
/**
 * Человекочитаемая причина для Notification.retiredReason (Пачка 19,
 * 12.09.2026), когда клиента реально передали другому агенту — «клиент
 * передан Иванову», а не машинный `[source] reason`, который несёт
 * `input.reason` (тот уже осел в Interaction внутри changeClientAgent). Когда
 * владелец не менялся (freeze, LOST и т.п.), вызывающий код передаёт
 * `input.reason` напрямую — он уже человеческий (см. например
 * `routes/agents.ts`: «Агент заморожен руководителем ...»).
 */
async function describeTransfer(toAgentId: string | null): Promise<string> {
  if (!toAgentId) return "Клиент снят с агента — в очереди руководителя";
  const agent = await prisma.agent.findUnique({ where: { id: toAgentId }, select: { fullName: true } });
  return `Клиент передан ${agent?.fullName ?? "другому агенту"}`;
}

export interface CloseOwnershipSatellitesInput {
  clientId: string;
  clientShortId?: number | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  reason: string;
  /**
   * Последний держатель, когда карточка ВЫШЛА ИЗ ОЧЕРЕДИ (fromAgentId пуст, toAgentId задан).
   * Задачи при уходе А в очередь остались на А (получателя не было), а при назначении Б
   * `agentChanged` ложен (fromAgentId пуст) и их не переносил: карточка у Б, календарная
   * задача у А (аудит 04.10.2026, CRM-02). Переезжают только задачи этого бывшего агента.
   */
  queueReturnFromAgentId?: string | null;
}

export async function closeOwnershipSatellites(input: CloseOwnershipSatellitesInput): Promise<void> {
  const { clientId, fromAgentId, toAgentId, reason } = input;
  const agentChanged = !!fromAgentId && fromAgentId !== toAgentId;

  /**
   * КАЖДЫЙ ШАГ — В СВОЁМ try/catch, А НЕ `.catch()` НА ПРОМИСЕ.
   *
   * `closeOwnershipSatellites` зовётся из ЕДИНОГО ВХОДА (`changeClientAgent`)
   * ВСЕГДА, когда меняется агент — то есть транзитивно из десятков мест,
   * которые в тестах часто мокают `push.js`/`notifications.js` частично
   * (`vi.mock("../src/push.js", () => ({ sendPushToAgent }))`, без
   * `closeLeadPushNotification`). Обращение к отсутствующему в фабрике мока
   * экспорту у vitest бросает синхронно, ДО создания промиса — `.catch(...)`
   * такую ошибку не ловит. try/catch ловит и синхронный throw, и отклонённый
   * промис — этим же приёмом эта функция остаётся best-effort и не должна
   * уронить саму передачу клиента ни от реальной сетевой ошибки, ни от
   * неполного мока в тесте, который до спутников вообще не добирался.
   */
  if (fromAgentId) {
    try {
      await closeLeadPushNotification(fromAgentId, `lead-${clientId}`);
    } catch (err) {
      void logSystemError(
        "api",
        `Пуш «новый лид» не закрыт при смене владения (${clientId}, агент ${fromAgentId}): ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      // Машинный префикс "[source] " (changeClientAgent/clientLifecycle) не
      // нужен в подписи на строке уведомления — там место для человека, не для
      // тега механизма.
      const retiredReason = agentChanged ? await describeTransfer(toAgentId) : reason.replace(/^\[[^\]]+\]\s*/, "");
      await closeNotifications(fromAgentId, { clientId, clientShortId: input.clientShortId ?? null }, retiredReason);
    } catch (err) {
      void logSystemError(
        "api",
        `Уведомления по клиенту не закрыты при смене владения (${clientId}, агент ${fromAgentId}): ${err instanceof Error ? err.message : err}`
      );
    }
  }

  if (agentChanged) {
    await transferOpenTasks(clientId, fromAgentId!, toAgentId);
  } else if (!fromAgentId && toAgentId && input.queueReturnFromAgentId && input.queueReturnFromAgentId !== toAgentId) {
    await transferOpenTasks(clientId, input.queueReturnFromAgentId, toAgentId);
  }

  /**
   * ЗАЯВКА НА УДАЛЕНИЕ — ПО `fromAgentId !== toAgentId`, А НЕ ПО `agentChanged`
   * (найдено 18.09.2026, разбор конфликта «заявка + оффер реактивации»).
   * `agentChanged` требует непустого `fromAgentId`, но карточка, пока висит
   * предложение реактивации, идёт с `assignedAgentId: null` — а директор (у кого
   * `clients.viewAll`) МОЖЕТ завести заявку на такую карточку (deleteRequests.ts
   * не держит проверку владельца для viewAll, даже когда поле пустое). Агент
   * нажимает «Принять» — `fromAgentId` в этот момент null, `!!null` даёт false,
   * и заявка оставалась бы висеть PENDING на карточке, которую только что
   * забрали в работу: тот же живой случай (Продавец №0127, 07.09.2026, см.
   * `trashClient.ts`), просто через null вместо прежнего агента.
   *
   * НЕ безусловно: `markClientLost` (lib/clientLifecycle.ts) зовёт эту функцию
   * НАПРЯМУЮ с `fromAgentId === toAgentId` (владелец не меняется, метка LOST не
   * повод переоценивать чужую заявку) — своя проверка нужна, `changeClientAgent`
   * сюда не гарантирует `fromAgentId !== toAgentId` для ВСЕХ вызывающих, только
   * для своего автоматического пути.
   */
  if (fromAgentId !== toAgentId) {
    try {
      await cancelPendingClientDeleteRequestOnTransfer(clientId);
    } catch (err) {
      void logSystemError(
        "api",
        `Заявка на удаление не снята при смене владения (${clientId}): ${err instanceof Error ? err.message : err}`
      );
    }
  }

  try {
    publishClientUpdated({ clientId, agentIds: [fromAgentId, toAgentId] });
  } catch (err) {
    void logSystemError(
      "api",
      `Живое обновление не опубликовано при смене владения (${clientId}): ${err instanceof Error ? err.message : err}`
    );
  }
}

/**
 * ОТКРЫТЫЕ ЗАДАЧИ (Interaction.nextAction/nextActionDate, ещё не выполненные)
 * ПЕРЕЕЗЖАЮТ ВМЕСТЕ С КЛИЕНТОМ. Факт с прода 11.09: 15 таких задач висели на
 * агентах, которые клиента больше не ведут. Если получателя нет (клиент ушёл
 * в очередь руководителя) — задачи остаются на прежнем агенте, но помечаются
 * в notes, чтобы при просмотре истории было видно: карточка уже не его.
 */
async function transferOpenTasks(clientId: string, fromAgentId: string, toAgentId: string | null): Promise<void> {
  try {
    if (toAgentId) {
      // Две половины одной передачи (23.09.2026): задачи, которые поставил сам
      // агент (agentId), и задачи, которые завели на него бот, ИИ или система
      // (agentId пуст, адресат — subjectAgentId, П-10). Вторые раньше не
      // переезжали: показ, назначенный ботом, оставался в календаре и
      // напоминаниях прежнего агента, а новый о нём не знал.
      await prisma.$transaction([
        prisma.interaction.updateMany({
          where: { clientId, agentId: fromAgentId, nextActionDate: { not: null }, completedAt: null, taskCancelledAt: null },
          data: { agentId: toAgentId },
        }),
        prisma.interaction.updateMany({
          where: { clientId, agentId: null, subjectAgentId: fromAgentId, nextActionDate: { not: null }, completedAt: null, taskCancelledAt: null },
          data: { subjectAgentId: toAgentId },
        }),
      ]);
      return;
    }
    const orphaned = await prisma.interaction.findMany({
      where: {
        clientId,
        nextActionDate: { not: null },
        completedAt: null, taskCancelledAt: null,
        OR: [{ agentId: fromAgentId }, { agentId: null, subjectAgentId: fromAgentId }],
      },
      select: { id: true, notes: true },
    });
    if (orphaned.length === 0) return;
    await Promise.all(
      orphaned.map((row) =>
        prisma.interaction.update({
          where: { id: row.id },
          data: { notes: `${row.notes}\n[клиент передан, задача осталась без нового исполнителя]` },
        })
      )
    );
  } catch (err) {
    void logSystemError(
      "api",
      `Открытые задачи не перенесены при смене владения (${clientId}): ${err instanceof Error ? err.message : err}`
    );
  }
}

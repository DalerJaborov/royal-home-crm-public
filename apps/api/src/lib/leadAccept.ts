import { prisma } from "../db.js";
import { publishLeadAccepted } from "./livePublish.js";
import { logTimeline } from "./timeline.js";
import { findAgentsWithPermission } from "./recipients.js";
import { closeLeadPushNotifications } from "../push.js";

/** Ответ на «Принять»/«Отклонить», когда лид уже у другого агента (409). */
export const LEAD_TAKEN_ERROR = "Заявка уже переназначена другому агенту";

/**
 * Приём лида агентом — вся логика в одном месте.
 *
 * Вынесено из routes/clients.ts 11.08.2026: приём доступен и из карточки, и
 * кнопкой прямо в шторке уведомлений, а два пути приёма с разной логикой
 * разошлись бы. Лимита активных лидов больше нет (владелец 16.11.2026), поэтому
 * и «освобождения места» под свой объект тоже нет — лид принимается всегда.
 */

export type AcceptOutcome =
  | { ok: true }
  | { ok: false; error: string; status: number };

/**
 * Принять лид. Возвращает исход, а не бросает: вызывающий маршрут переводит его
 * в HTTP, а кнопка из шторки уведомлений — в текст уведомления.
 */
export async function acceptLead(input: {
  clientId: string;
  agentId: string;
}): Promise<AcceptOutcome> {
  // ПРИСУТСТВИЕ (ПР-000477, 25.09.2026): кнопка «Принять» в шторке пуша идёт
  // через routes/push.ts — единственный маршрут CRM без requireAuth, значит и
  // без его touchLastSeen. Агент, принявший лид прямо с экрана блокировки,
  // явно работает — pickAgentForLead должен это видеть так же, как заход в
  // приложение. Не throttled (в отличие от auth/middleware.ts): приём лида не
  // частое действие, лишний UPDATE не страшен.
  void prisma.agent.update({ where: { id: input.agentId }, data: { lastSeenAt: new Date() } }).catch(() => {});

  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) return { ok: false, error: "Клиент не найден", status: 404 };
  if (client.assignmentCompletedAt) return { ok: false, error: "Работа по назначению завершена — требуется новое назначение руководителем", status: 409 };
  // Карточка в Корзине принимать нечего (живой случай 15.09.2026: 30+ клиентов
  // «приняты успешно», а карточки нет ни в одном списке — все точки чтения
  // отсекают deletedAt строго, эта точка записи не отсекала вовсе).
  if (client.deletedAt) {
    return { ok: false, error: "Карточка в Корзине — сначала восстановите её, принимать пока нечего", status: 400 };
  }
  // 409, а не 403: лид ушёл другому (крон передал дальше, пока нажатие ждало
  // сети). См. комментарий у POST /:id/accept.
  if (client.assignedAgentId !== input.agentId) {
    return { ok: false, error: LEAD_TAKEN_ERROR, status: 409 };
  }
  // Уже принят — повторный клик и повторная доставка уведомления не должны
  // ничего ломать (кнопка в шторке может нажаться дважды).
  if (client.acceptedAt) return { ok: true };

  /**
   * ПРИЁМ — АТОМАРНЫЙ ЗАХВАТ, А НЕ БЕЗУСЛОВНАЯ ЗАПИСЬ (аудит №4, 27.08).
   *
   * Между проверками выше и этой строкой проходят несколько await (лимиты,
   * кандидаты на освобождение). Ровно в это окно крон переназначения
   * (services/leads/reassignment.ts, тик раз в 5 минут) мог перевести лид на
   * другого агента — и безусловный update ставил acceptedAt уже ЧУЖОМУ лиду:
   * агент видел «принято», но карточка принадлежала другому и была ему
   * недоступна. Условие `assignedAgentId=я, acceptedAt=null` делает арбитром
   * базу; count=0 — лид ушёл, честно говорим об этом.
   */
  const claimed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.client.updateMany({
      // deletedAt: null закрывает гонку «удалили между чтением клиента выше и
      // этой записью» — без него count всё равно был бы 1, и приём молча
      // "успевал" на уже удалённую карточку.
      where: { id: client.id, assignedAgentId: input.agentId, acceptedAt: null, deletedAt: null, assignmentCompletedAt: null },
      /**
       * escalatedAt сбрасываем: как только лид приняли, «требует внимания» снимается.
       *
       * workStatus ВОЗВРАЩАЕТСЯ В ACTIVE (владелец 19.09.2026, жалоба агентов
       * «приходят карточки старых клиентов, принимаешь — а в работе их нет»).
       * Карточка молчавшего клиента получает workStatus=INACTIVE ночным кроном
       * (lib/silentClientAutoDeactivate.ts), но из круга раздачи лидов при этом
       * не выпадает: её снова предлагают агенту как новый лид. Приём писал
       * только acceptedAt/escalatedAt — метка «Неактивный» оставалась, а главная
       * агента неактивных отбрасывает целиком (web/src/lib/agentDay.ts,
       * buildPortfolio): «Мои клиенты», «Горячие» и «Кто молчит» её не
       * показывали. Карточка существовала только во вкладке «Клиенты» серой
       * строкой — агент честно считал, что принял лид и потерял его.
       *
       * На проде 19.09.2026 так висела почти половина портфеля у каждого агента
       * (18 из 38, 14 из 42, 13 из 27). Приём — момент, когда карточка снова
       * становится живой работой: тогда и метка обязана сняться.
       */
      data: { acceptedAt: new Date(), escalatedAt: null, workStatus: "ACTIVE" },
    });
    if (count === 0) return false;
    // Реальное действие агента (кнопка «Принять») — legitimate kind agent.
    await logTimeline({
      clientId: client.id,
      actor: { kind: "agent", agentId: input.agentId },
      type: "SYSTEM",
      notes: "Лид принят агентом — контакты открыты",
      tx,
    });
    // Royal Score: «После успешной обработки любого нового лида счётчик отказов
    // автоматически обнуляется» (спецификация, часть 3) — единственная точка
    // сброса, остальные действия по клиенту счётчик не трогают.
    await tx.agent.update({ where: { id: input.agentId }, data: { consecutiveLeadDeclines: 0 } });
    return true;
  });

  if (!claimed) {
    // Гонка с кроном переназначения: лид уже у другого агента (или принят
    // соседним нажатием). Освобождать место под него тоже не нужно.
    const now = await prisma.client.findUnique({
      where: { id: client.id },
      select: { assignedAgentId: true, acceptedAt: true },
    });
    if (now?.assignedAgentId === input.agentId && now.acceptedAt) return { ok: true };
    return { ok: false, error: LEAD_TAKEN_ERROR, status: 409 };
  }

  // ПОСЛЕ успешного коммита (не внутри транзакции): событие, пережившее откат,
  // отправило бы браузер за данными, которых нет. Гасит предложение лида в
  // открытых вкладках — и у принявшего, и у руководителей.
  publishLeadAccepted(client.id, input.agentId);

  // Лид был эскалирован (никто не принял вовремя) и его принял сам держатель,
  // минуя разбор руководителем (найдено 07.09.2026, тот же класс бага, что и
  // кража лида через /assign) — «⚠️ Заявку никто не принял» у ВСЕХ
  // руководителей теперь враньё: приём выше уже сбросил escalatedAt. Без этого
  // уведомление продолжало бы висеть в шторке/на бейдже, и кто-то из
  // руководителей мог бы позже нажать на нём «Взять себе», отобрав уже
  // принятый лид (та самая жалоба про Нозу).
  if (client.escalatedAt) {
    void (async () => {
      const supervisors = await findAgentsWithPermission("clients.assign");
      await closeLeadPushNotifications(
        supervisors.flatMap((id) => [
          { agentId: id, tag: `lead-escalated-${client.id}` },
          { agentId: id, tag: `refusal-escalated-${client.id}` },
          { agentId: id, tag: `transfer-conflict-${client.id}` },
        ])
      );
    })().catch((err) => console.error("[push] закрытие эскалаций после самостоятельного приёма:", err));
  }

  // Обязательное окно «Итог разговора» через час после принятия (kind="call") убрано
  // 12.08.2026: контроль теперь идёт через call_result — окно после КАЖДОГО звонка
  // через CRM, включая недозвон (см. lib/telephony/callTracker.ts). Отдельный
  // контроль «час прошёл, а звонка не было» не заводится: та же дыра закрыта иначе —
  // lib/leads.ts::handleMissedFirstCalls уже штрафует и снимает лид, если агент
  // за отведённое время вообще не позвонил.

  return { ok: true };
}

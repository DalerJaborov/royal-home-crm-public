import { prisma } from "../db.js";
import { publishLeadAccepted } from "./livePublish.js";
import { logTimeline } from "./timeline.js";
import type { ClientKind } from "@royal-home/shared";
import { pickAgentForLead } from "../leads.js";
import { activeLeadCounts, loadLeadLimits, slotsTaken, OCCUPIES_SLOT_WHERE } from "./leadLimits.js";
import { transferClientToAgent } from "./clientTransfer.js";
import { sendLeadPush } from "./pushLeadActions.js";
import { findAgentsWithPermission } from "./recipients.js";
import { closeLeadPushNotifications, sendPushToAgents } from "../push.js";

/** Ответ на «Принять»/«Отклонить», когда лид уже у другого агента (409). */
export const LEAD_TAKEN_ERROR = "Заявка уже переназначена другому агенту";

/**
 * Приём лида агентом — вся логика в одном месте.
 *
 * Вынесено из routes/clients.ts 11.08.2026 по двум причинам. Первая: приём
 * должен быть доступен не только из карточки, но и кнопкой прямо в шторке
 * уведомлений, а два пути приёма с разной логикой разойдутся — окно «Итог
 * разговора» заводилось бы только через интерфейс. Вторая: к приёму добавилось
 * освобождение места, и держать его в маршруте рядом с проверкой прав значит
 * смешать «кому можно» с «что происходит».
 *
 * ОСВОБОЖДЕНИЕ МЕСТА (решение владельца 11.08.2026). Лимит активных лидов
 * ограничивает СМЕШАННЫЙ портфель. Лид по своему объекту («на 1%» — агент сам
 * принял объект и получает обе половины комиссии) за лимит выходить может, но
 * по правилу: сначала агенту предлагается отдать один свой ОБЫЧНЫЙ лид. Когда
 * обычных не осталось, свои берутся сверх лимита без всяких предложений —
 * дословно: «максимум можно много брать лидов, если твои собственные объекты».
 */

export type AcceptOutcome =
  | { ok: true; requiresRelease?: false; releasedClientId?: string }
  /** Портфель полон, и агенту нужно выбрать, кого отдать. Приём не состоялся. */
  | { ok: false; requiresRelease: true; candidates: ReleaseCandidate[] }
  | { ok: false; requiresRelease?: false; error: string; status: number };

export interface ReleaseCandidate {
  id: string;
  shortId: number;
  fullName: string;
  /** Роль перед именем и приставка номера («Продавец ПР-000058») в списке кандидатов. */
  kind: ClientKind;
  status: string;
  /** Когда назначен — по нему агенту проще понять, кто из них мёртвый. */
  assignedAt: Date;
}

/**
 * Обычные (0.5%) активные лиды агента — только их и предлагается освободить.
 * Лиды по своим объектам не трогаются никогда: ради них всё и затевалось.
 *
 * П-4/П-6 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): система
 * жертву сама не выбирает, и из кандидатов исключён клиент, с которым уже был
 * разговор — иначе портфель полон, но контактные клиенты появлялись в списке
 * "на отдать", хотя закон П-3 их автопередачу запрещает. `firstContactAt` и
 * `lastAgentAttemptAt` — те же два поля, которыми `hasContactAttempt` (П-2)
 * определяет контакт; берём их прямо в фильтре, а не построчным снимком через
 * loadOwnershipSnapshot — тут решает список из полусотни клиентов агента, и
 * N+1 запросов ради каждого был бы неоправдан.
 */
async function releaseCandidates(agentId: string, exceptClientId: string): Promise<ReleaseCandidate[]> {
  const rows = await prisma.client.findMany({
    where: {
      assignedAgentId: agentId,
      id: { not: exceptClientId },
      ownPropertyLead: false,
      firstContactAt: null,
      lastAgentAttemptAt: null,
      ...OCCUPIES_SLOT_WHERE,
      deletedAt: null,
    },
    select: { id: true, shortId: true, fullName: true, kind: true, status: true, assignedAt: true },
    // Сначала самые давние: клиент, лежащий дольше всех без движения, — первый
    // кандидат на то, чтобы отдать его тому, у кого до него дойдут руки.
    orderBy: { assignedAt: "asc" },
    take: 50,
  });
  return rows;
}

/**
 * Принять лид. Возвращает исход, а не бросает: вызывающий маршрут переводит его
 * в HTTP, а кнопка из шторки уведомлений — в текст уведомления.
 */
export async function acceptLead(input: {
  clientId: string;
  agentId: string;
  /** Кого агент решил отдать, чтобы освободить место (режим «агент выбирает»). */
  releaseClientId?: string;
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

  const limits = await loadLeadLimits();
  let releasedClientId: string | undefined;
  // П-4/П-6 (17.09.2026): кандидатов на освобождение нет, потому что весь
  // портфель — клиенты, с которыми уже был контакт. Лид принимается сверх
  // лимита, но это отдельный от «портфель весь свой» случай — запись в
  // хронологию должна честно называть причину.
  let overLimitAllContacted = false;

  // Место освобождается ТОЛЬКО под лид по своему объекту и только когда портфель
  // реально полон. Обычный лид сверх лимита не приходит вовсе — его туда не
  // пускает распределение (assignAgentForLead).
  if (client.ownPropertyLead && limits.activeLimit > 0 && limits.overLimitEnabled && limits.releaseEnabled) {
    const counts = (await activeLeadCounts([input.agentId])).get(input.agentId);
    // Занятые слоты, а не штуки: со включёнными весами (Настройки →
    // «Взвешенные слоты») доведённый до показа клиент занимает пол-места, и
    // освобождать место под свой лид приходится реже. Счёт уже включает
    // принимаемого клиента — он назначен, просто не принят.
    const taken = slotsTaken(counts, limits);
    if (taken > limits.activeLimit) {
      // Режим "random" убран по закону владения (П-4/П-6, 17.09.2026) — система
      // больше не выбирает жертву сама, кандидата называет только агент.
      const candidates = await releaseCandidates(input.agentId, client.id);
      if (candidates.length > 0) {
        if (input.releaseClientId) {
          if (!candidates.some((c) => c.id === input.releaseClientId)) {
            return { ok: false, error: "Этого клиента освободить нельзя", status: 409 };
          }
          releasedClientId = input.releaseClientId;
        } else {
          // «Агент выбирает» — он один знает, какой клиент уже мёртвый. Приём не
          // состоялся, интерфейс покажет список и вернётся сюда с выбором.
          return { ok: false, requiresRelease: true, candidates };
        }
      } else {
        // Кандидатов нет: либо портфель весь из своих объектов, либо (П-4) весь
        // из клиентов, с которыми уже был контакт, — их автопередача запрещена
        // законом П-3. В обоих случаях берём сверх лимита без освобождения —
        // «можно много брать, если твои собственные», — но помечаем причину.
        const allOwn = await prisma.client.count({
          where: {
            assignedAgentId: input.agentId,
            id: { not: client.id },
            ownPropertyLead: false,
            ...OCCUPIES_SLOT_WHERE,
            deletedAt: null,
          },
        });
        overLimitAllContacted = allOwn > 0;
      }
    }
  }

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
      where: { id: client.id, assignedAgentId: input.agentId, acceptedAt: null, deletedAt: null },
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
      notes: overLimitAllContacted
        ? "Лид принят агентом — контакты открыты (сверх лимита: все клиенты портфеля с контактом, освобождать нельзя — П-3)"
        : "Лид принят агентом — контакты открыты",
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
  // lib/leads.ts::penalizeMissedFirstCalls уже штрафует и снимает лид, если агент
  // за отведённое время вообще не позвонил.

  // Освобождённый клиент уходит следующему по обычной очереди — уже ПОСЛЕ приёма:
  // если передача сорвётся, агент всё равно получил лид, ради которого всё и было.
  if (releasedClientId) {
    void releaseClient(releasedClientId, input.agentId).catch((err) =>
      console.error("[лиды] освобождение места:", err instanceof Error ? err.message : err)
    );
  }

  return { ok: true, releasedClientId };
}

/**
 * СБОЙ ОСВОБОЖДЕНИЯ НЕ ДОЛЖЕН ПРОПАДАТЬ МОЛЧА (пачка 10, 11.09.2026, п.4 —
 * flow-audit-lead-to-showing-11-09.md, ТОП-10 п.6). Раньше единственным следом
 * была строка в console.error: и некому передать (все заняты/выключены), и
 * ошибка внутри transferClientToAgent одинаково терялись — агент, отдавший
 * клиента, не знал, что тот НИКУДА не ушёл и по-прежнему числится его портфелем.
 */
async function reportReleaseFailure(clientId: string, fromAgentId: string, reason: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { fullName: true, shortId: true },
  });
  await prisma.interaction
    .create({
      data: {
        clientId,
        agentId: fromAgentId,
        type: "SYSTEM",
        notes: `Не удалось передать освобождённого клиента другому агенту: ${reason}. Клиент остался у прежнего агента.`,
      },
    })
    .catch((err) => console.error("[лиды] запись о сбое освобождения:", err instanceof Error ? err.message : err));

  const supervisors = await findAgentsWithPermission("clients.assign");
  if (supervisors.length === 0) return;
  await sendPushToAgents(supervisors, {
    title: "⚠️ Освобождение места не удалось",
    body: `${client?.fullName ?? "Клиент"}: ${reason}`,
    url: client ? `/clients/${client.shortId}` : undefined,
    tag: `release-failed-${clientId}`,
  }).catch((err) => console.error("[push] сбой освобождения места:", err));
}

/** Отдать обычного клиента другому агенту, чтобы освободить место под свой объект. */
async function releaseClient(clientId: string, fromAgentId: string): Promise<void> {
  const toAgentId = await pickAgentForLead([fromAgentId]);
  if (!toAgentId) {
    // Некому — клиент остаётся у прежнего агента, это лучше, чем ничей, но
    // руководитель должен знать, что портфель полон, а передать было некому.
    await reportReleaseFailure(clientId, fromAgentId, "нет свободного агента, кому передать");
    return;
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { fullName: true, shortId: true },
  });
  if (!client) return;

  try {
    await transferClientToAgent({
      clientId,
      fromAgentId,
      toAgentId,
      note: "Передан другому агенту: прежний освободил место под клиента по своему объекту",
    });
  } catch (err) {
    await reportReleaseFailure(clientId, fromAgentId, err instanceof Error ? err.message : "неизвестная ошибка передачи");
    return;
  }

  // Для нового агента это непринятый лид (transferClientToAgent сбрасывает
  // acceptedAt) — значит уведомление такое же, как о новом лиде, с кнопками.
  sendLeadPush(toAgentId, clientId, {
    title: "🤝 Вам передали клиента",
    body: `${client.fullName} — у прежнего агента освободилось место`,
    url: `/clients/${client.shortId}`,
    tag: `lead-${clientId}`,
  }).catch((err) => console.error("[push] освобождение места:", err));
}

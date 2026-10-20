import { formatClientCode, type ClientKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { absentAgentIds } from "./agentAvailability.js";
import { dushanbeNextOccurrence } from "./dushanbeTime.js";
import { logTimeline } from "./timeline.js";
import { reportCronRowError } from "./cronHeartbeat.js";
import { hasOpenMessagingChannel } from "./messagingWindow.js";

/**
 * «ЗАСТОЙ СДЕЛКИ» — пункт 4 списка владельца от 30.08.2026, дословно: «если агент
 * с момента первого контакта прошло много времени и не добавил объект (если это
 * был продавец) или не продал объект (если это был покупатель) — надо уведомления
 * мне и задачи агенту».
 *
 * НА МОМЕНТ ДИАГНОСТИКИ (30.08.2026): 35 продавцов без единого объекта старше
 * недели, 25 покупателей без единой сделки старше недели, за всё время создано
 * только 6 сделок. Механизма не было вовсе — ни уведомления, ни задачи.
 *
 * Построено по образцу lib/noAnswerStreak.ts: тот же получатель эскалации
 * (findAgentsWithPermission("clients.assign")), та же форма задачи агенту
 * (Interaction type="SYSTEM" с nextAction/nextActionDate), те же настраиваемые
 * пороги в Settings (по образцу propertySummaryAfterHours в pendingSummaries.ts) —
 * владелец правит дни без выката.
 *
 * ОДИН РАЗ НА КЛИЕНТА. Без отметки «уже эскалировано» кто-то каждую ночь получал
 * бы одну и ту же задачу и один и тот же пуш до тех пор, пока карточка не
 * сдвинется, — это не контроль, а раздражение, которое быстро начинают
 * игнорировать (см. пример с недозвонами, откуда и взят паттерн). Отметка —
 * Client.dealStaleEscalatedAt (DateTime?, схема не тронута этим агентом —
 * владелец добавляет сам, см. отчёт).
 *
 * ПОЧЕМУ ДВА РАЗНЫХ ПОРОГА. Продавец без объекта дольше недели — уже подозрительно
 * (объект заводится один-два разговора спустя). Покупатель без единой сделки —
 * это НОРМАЛЬНОЕ состояние подавляющего большинства активных карточек в любой
 * момент времени (подбор и показы тянутся неделями), поэтому владелец в самой
 * заявке сравнивал это с «месяцем», а не с неделей. Здесь порог по умолчанию
 * ниже месяца (21 день) НАРОЧНО: база живёт всего две недели с запуска, и
 * месячный порог не сработал бы ни разу ни на одном клиенте — проверить работу
 * механизма было бы не на чем. Число настраиваемое, владелец может вернуть к
 * месяцу в любой момент через Настройки.
 *
 * НАЧАТАЯ СДЕЛКА — НЕ ЗАСТОЙ. У покупателя проверяется «нет ни одной Deal вообще»
 * (любой стадии, включая самую раннюю NEGOTIATION) — начатая сделка означает
 * «двигается», даже если до закрытия ещё далеко. Донимать агента напоминанием
 * про сделку, которую он уже открыл, было бы тем самым раздражающим шумом,
 * которого весь этот файл старается избежать.
 */

const FALLBACK: DealStaleRules = {
  sellerDays: 10,
  buyerDays: 21,
};

export interface DealStaleRules {
  /** Продавец без единого объекта дольше стольких дней с момента создания карточки. */
  sellerDays: number;
  /** Покупатель без единой сделки (любой стадии) дольше стольких дней. */
  buyerDays: number;
}

export async function loadDealStaleRules(): Promise<DealStaleRules> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { dealStaleSellerDays: true, dealStaleBuyerDays: true },
    });
    return {
      sellerDays: s?.dealStaleSellerDays ?? FALLBACK.sellerDays,
      buyerDays: s?.dealStaleBuyerDays ?? FALLBACK.buyerDays,
    };
  } catch {
    return { ...FALLBACK };
  }
}

/** Статусы, при которых карточка уже не в работе — гонять застой по ним незачем:
 *  «Потерян»/«Сделка закрыта»/«Архив» и так объясняют отсутствие движения. */
const ACTIVE_STATUS_WHERE = ["LOST", "DEAL_CLOSED", "ARCHIVED"] as const;

interface StaleCandidate {
  id: string;
  shortId: number;
  fullName: string;
  kind: ClientKind;
  assignedAgentId: string | null;
  createdAt: Date;
}

/**
 * Продавцы без единого объекта.
 *
 * Property.sellerClientId — обычная строка БЕЗ внешнего ключа (см. комментарий в
 * schema.prisma у самого поля), поэтому связь «нет объекта» нельзя выразить
 * реляционным фильтром Prisma (`properties: { none: {} }` тут не работает — такой
 * relation-поле не существует). Два запроса вместо одного: сперва кандидаты по
 * своим полям, потом — какие из них всё-таки засветились как sellerClientId хотя
 * бы у одного объекта, независимо от статуса объекта.
 */
async function findStaleSellers(cutoff: Date): Promise<StaleCandidate[]> {
  const candidates = await prisma.client.findMany({
    where: {
      kind: "SELLER",
      deletedAt: null,
      status: { notIn: [...ACTIVE_STATUS_WHERE] },
      dealStaleEscalatedAt: null,
      createdAt: { lt: cutoff },
      /**
       * УЖЕ У СБ (30.08.2026) — lib/sellerPropertyMissingAntifraud.ts критичным
       * случаем того же «продавец без объекта» уже мог поставить securityReview=
       * PENDING и завести карточку в очередь службы безопасности. Второй, независимый
       * пуш руководству «застой сделки» по тому же клиенту в этот момент не добавляет
       * информации, а путает: два разных механизма про одно и то же расхождение,
       * один уже эскалирован. CLEARED/CONFIRMED не исключаем — СБ решение уже приняла,
       * напоминание агенту снова уместно.
       *
       * NULL (карточка у СБ не была вовсе) — тоже кандидат. Через `NOT: { field: value }`
       * Prisma генерирует `field <> value`, и SQL отбрасывает NULL: на проде 17.09.2026 так
       * молча пропускались 49 продавцов без объекта старше 10 дней. Поэтому явный OR.
       */
      OR: [{ securityReview: null }, { securityReview: { not: "PENDING" } }],
    },
    select: { id: true, shortId: true, fullName: true, kind: true, assignedAgentId: true, createdAt: true },
    take: 200,
  });
  if (candidates.length === 0) return [];

  const withProperty = await prisma.property.findMany({
    where: { sellerClientId: { in: candidates.map((c) => c.id) } },
    select: { sellerClientId: true },
    distinct: ["sellerClientId"],
  });
  const haveProperty = new Set(withProperty.map((p) => p.sellerClientId));
  return candidates.filter((c) => !haveProperty.has(c.id));
}

/** Покупатели без единой сделки (любой стадии) — здесь связь настоящая (Deal.clientId),
 *  фильтруется прямо в запросе. */
async function findStaleBuyers(cutoff: Date): Promise<StaleCandidate[]> {
  return prisma.client.findMany({
    where: {
      kind: "BUYER",
      deletedAt: null,
      status: { notIn: [...ACTIVE_STATUS_WHERE] },
      dealStaleEscalatedAt: null,
      createdAt: { lt: cutoff },
      deals: { none: {} },
    },
    select: { id: true, shortId: true, fullName: true, kind: true, assignedAgentId: true, createdAt: true },
    take: 200,
  });
}

/** Дней с момента создания карточки, округление вниз — «10 дней» должно означать
 *  «прошло не меньше десяти», а не «уже почти десять». */
function daysSince(at: Date, now: Date): number {
  return Math.floor((now.getTime() - at.getTime()) / 86_400_000);
}

/**
 * Пуш руководству + задача ведущему агенту, ровно один раз на клиента.
 *
 * Порядок нарочно такой: сперва задача и пуш (best-effort, ошибка одного не
 * должна отменять другой — как в notifyNoAnswerEscalation), и только в самом
 * конце — отметка dealStaleEscalatedAt. Если процесс упадёт где-то посреди, при
 * следующем ночном прогоне клиент попадёт в выборку заново — лучше редкое
 * повторное уведомление, чем тихо пропущенное навсегда.
 */
async function escalateStaleDeal(client: StaleCandidate, days: number, now: Date): Promise<void> {
  const isSeller = client.kind === "SELLER";
  const code = formatClientCode(client.shortId, client.kind);
  let agentActionText = isSeller
    ? `Добавьте объект по заявке ${code} — уже ${days} дн. без объекта с момента первого контакта`
    : `Закройте сделку или обновите статус по заявке ${code} — уже ${days} дн. без единой сделки`;

  /**
   * КОРЕНЬ ЗАВИСШИХ КАРТОЧЕК «МОЙ ФОКУС» (владелец 18.09.2026, по фото). Раньше
   * задача создавалась вообще без взгляда на то, дойдёт ли до клиента сообщение:
   * агент видел «закройте сделку» и пытался написать, а WhatsApp/Instagram
   * молча отклоняли — окно 24 часа с последней реплики клиента уже закрыто. Звонок
   * через CRM всегда технически доступен (номер клиента обязателен в базе,
   * дозвон идёт по clientId, а не по видимому агенту номеру), поэтому тупика
   * «ни одно действие невозможно» после этой правки уже не бывает — но подсказка
   * обязана называть РАБОЧИЙ канал сразу, а не заставлять агента тратить попытку
   * на переписку, чтобы узнать то, что CRM уже знает.
   */
  const canWrite = await hasOpenMessagingChannel(client.id);
  if (!canWrite) {
    agentActionText += ". Написать нельзя — окно переписки закрыто (клиент не писал больше суток), звоните";
  }

  if (client.assignedAgentId) {
    /**
     * ОШИБКУ СОЗДАНИЯ ЗАДАЧИ НЕ ГЛОТАЕМ (аудит Codex 04.10, CHANNEL-NEW-02). Раньше
     * здесь был catch, а отметка dealStaleEscalatedAt ставилась ниже безусловно:
     * обе выборки исключают клиента с отметкой, и после временного сбоя задача не
     * создавалась никогда. Теперь исключение уходит в обёртку по строке
     * (runDealStalePipeline → reportCronRowError, она пишет в журнал ошибок), отметка
     * остаётся пустой, и следующий ночной прогон повторит. Клиент без ведущего агента
     * задачи не получает по-прежнему: отметка ставится, чтобы не подбирать его каждую ночь.
     */
    await logTimeline({
      clientId: client.id,
      actor: { kind: "system", source: "dealStalePipeline", subjectAgentId: client.assignedAgentId },
      type: "SYSTEM",
      notes: agentActionText,
      // autoTaskKind (21.09.2026, lib/autoTasks.ts) — по нему автозакрытие
      // снимает задачу, когда продавец наконец получил объект / покупатель
      // закрыл сделку (см. routes/properties/crud.ts, routes/deals.ts).
      // Повторного дедупа здесь не требуется — client.dealStaleEscalatedAt
      // уже гарантирует «один раз на клиента» (см. докстринг файла выше).
      autoTaskKind: isSeller ? "deal_stale_seller_add_property" : "deal_stale_buyer_close_deal",
      nextAction: agentActionText,
      /**
       * СРОК — КОНЕЦ РАБОЧЕГО ДНЯ ПО ДУШАНБЕ, А НЕ МОМЕНТ НОЧНОГО КРОНА
       * (17.09.2026, жалоба владельца: задача «Закройте сделку…» показывала
       * «к 00:20» — время, когда отработал ночной cron, а не разумный срок).
       * Главная показывает nextActionDate как срок буквально, поэтому и
       * писать сюда нужно настоящий дедлайн: сегодня в 18:00, а если крон
       * почему-то отработал уже после 18:00 — 18:00 следующего дня
       * (dushanbeNextOccurrence и так считает именно это, «строго после at»).
       */
      nextActionDate: dushanbeNextOccurrence("18:00", now),
    });
  }

  /**
   * PUSH РУКОВОДСТВУ «ЗАСТОЙ N ДН.» УБРАН (владелец 20.09.2026: «Сделка: застой
   * N дн удалить», «эскалация убрать — руководитель всё равно видит это на
   * своём дашборде»). Задача ведущему агенту выше остаётся: она адресная и
   * говорит, что именно сделать. Отметка dealStaleEscalatedAt тоже остаётся —
   * по ней и дальше видно, что случай уже разобран, и повторно он не всплывёт.
   */

  await prisma.client.update({ where: { id: client.id }, data: { dealStaleEscalatedAt: new Date() } });
}

export interface DealStaleRunSummary {
  sellersEscalated: number;
  buyersEscalated: number;
}

/** Запуск раз в сутки (см. cron.ts) — не срочный сигнал, гонять чаще незачем. */
export async function runDealStalePipeline(now: Date = new Date()): Promise<DealStaleRunSummary> {
  const rules = await loadDealStaleRules();
  const sellerCutoff = new Date(now.getTime() - rules.sellerDays * 86_400_000);
  const buyerCutoff = new Date(now.getTime() - rules.buyerDays * 86_400_000);

  const [sellersAll, buyersAll, absent] = await Promise.all([
    findStaleSellers(sellerCutoff),
    findStaleBuyers(buyerCutoff),
    absentAgentIds(),
  ]);

  /**
   * АГЕНТА НЕТ НА РАБОТЕ — застой не его вина (владелец 08.09.2026, см.
   * agentAvailability.ts). Раньше отпуск и больничный здесь ничего не значили:
   * отсутствующему заводилась задача «добавьте объект», а руководителю уходила
   * тревога «застой N дней» — по клиенту, с которым агент физически не мог
   * работать. Пауза «не принимаю новых лидов» отсутствием не считается.
   *
   * Клиент при этом не забыт: карточка остаётся в застое, и как только агент
   * вернётся, следующий же прогон её увидит.
   */
  const working = (c: { assignedAgentId: string | null }) => !c.assignedAgentId || !absent.has(c.assignedAgentId);
  const sellers = sellersAll.filter(working);
  const buyers = buyersAll.filter(working);

  // Последовательно, не Promise.all — каждый шаг пишет в БД и шлёт пуш; при
  // сотнях кандидатов параллельный залп на одну и ту же таблицу Client того не
  // стоит (см. правило N+1 в CLAUDE.md — но здесь запись, а не чтение в цикле,
  // и объём в реальности единицы-десятки клиентов за прогон).
  let sellersEscalated = 0;
  let buyersEscalated = 0;
  for (const client of sellers) {
    // Сбой одной записи не обрывает остальные (E8 глубокой проверки 02.10.2026, класс №173).
    try {
      await escalateStaleDeal(client, daysSince(client.createdAt, now), now);
      sellersEscalated++;
    } catch (err) {
      reportCronRowError("Застой сделки продавца", client.shortId, err);
    }
  }
  for (const client of buyers) {
    // Сбой одной записи не обрывает остальные (E8 глубокой проверки 02.10.2026, класс №173).
    try {
      await escalateStaleDeal(client, daysSince(client.createdAt, now), now);
      buyersEscalated++;
    } catch (err) {
      reportCronRowError("Застой сделки покупателя", client.shortId, err);
    }
  }

  return { sellersEscalated, buyersEscalated };
}

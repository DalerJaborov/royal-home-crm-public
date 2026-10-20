/**
 * Авто-соединение «клиент просит звонок» с дежурным оператором.
 *
 * Владелец 16.08.2026: «у нас будет свой оператор (сейчас Нурмухаммад, потом другой
 * человек). Бот получил номер — в рабочее время сразу соединять, вне рабочего —
 * позвонить в рабочее время».
 *
 * КАК СОЕДИНЯЕМ. Тем же Originate, что и кнопка «Позвонить» в карточке клиента:
 * сначала звонит трубка оператора (на экране — имя клиента и тема), он снимает —
 * станция набирает клиента. Дальше звонок идёт обычным конвейером звонков CRM:
 * запись, расшифровка, окно итога, след в хронологии, — то есть оператор получает
 * ровно ту же карточку и разбор, что и на входящих. Никакого второго пути звонка
 * мы не строим — и это принципиально: два пути расходятся молча.
 *
 * ПОЧЕМУ ТРУБКА ОПЕРАТОРА ПЕРВАЯ, А НЕ КЛИЕНТА. Наоборот нельзя: клиент снял бы
 * трубку и слушал гудки, пока станция ищет оператора, — это хуже, чем не звонить.
 * Оператор занят или не снял — клиент вообще ничего не заметил, запрос остался в
 * очереди, и его видно в баннере.
 *
 * ГРАНИЦЫ МОДУЛЯ. Здесь только соединение одного запроса. Когда пробовать (сразу /
 * утром по крону) решают вызывающие: recordCallbackRequest и тик callback-connect.
 *
 * ТОЛЬКО В HTTP-ПРОЦЕССЕ (02.10.2026, аудит фона №1). hasLiveCall и trackCall —
 * память процесса, куда приходят события АТС (api). Тик живёт в
 * lib/telephony/callMemoryTicks.ts и запускается из index.ts; из worker (cron.ts)
 * его звать нельзя — запись легла бы в пустую карту worker и висела бы там
 * «operator_busy» до выката, а исход звонка не дописал бы никто.
 */

import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { describeError } from "../describeError.js";
import { sendPushToAgent } from "../../push.js";
import { isWithinWorkingHours } from "../workingHours.js";
import {
  loadAgentDialMode,
  loadAriCredentials,
  originateCall,
  resolveAgentDialTarget,
} from "./ariClient.js";
import { beginOrigination, CALLBACK_CALL_NOTE_PREFIX, endOrigination, hasLiveCall, trackCall } from "./callTracker.js";

/** Итог попытки — коротким кодом: по нему решают, оставлять ли запрос в очереди. */
export type CallbackConnectOutcome =
  | "connected"
  | "no_operator"
  | "operator_busy"
  | "no_phone"
  | "off_hours"
  | "closed"
  | "failed";

/**
 * Каналы, чьи просьбы вправе попасть к дежурному оператору (владелец 22.09.2026):
 * только звонки через АТС. Просьбы из соцсетей/мессенджеров (WHATSAPP, INSTAGRAM,
 * FACEBOOK, TELEGRAM, …) — агентам; их оператор не набирает ни сразу, ни кроном.
 */
const OPERATOR_CALLBACK_CHANNELS: readonly string[] = ["LIVE_VOICE"];

export function isOperatorCallbackChannel(channel: string | null | undefined): boolean {
  return !!channel && OPERATOR_CALLBACK_CHANNELS.includes(channel);
}

/** Дежурный оператор из Настроек — с проверкой, что он вообще может звонить. */
async function loadDutyOperator(): Promise<{ id: string; fullName: string; sipExtension: string; phone: string | null } | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callbackOperatorAgentId: true },
  });
  if (!settings?.callbackOperatorAgentId) return null;
  const agent = await prisma.agent.findUnique({
    where: { id: settings.callbackOperatorAgentId },
    select: { id: true, fullName: true, sipExtension: true, phone: true, isActive: true },
  });
  // Выключенный (уволенный) или оставшийся без внутреннего номера дежурный — это
  // «дежурного нет», а не падение: очередь продолжает работать через баннер.
  if (!agent || !agent.isActive || !agent.sipExtension) return null;
  return { id: agent.id, fullName: agent.fullName, sipExtension: agent.sipExtension, phone: agent.phone };
}

/**
 * Пытается соединить один запрос с дежурным оператором.
 *
 * Ничего не бросает: любой сбой — это код исхода и строка в журнале, а запрос
 * остаётся открытым и виден в баннере. Автоматика, роняющая ход диалога бота,
 * недопустима — клиенту уже ушёл ответ.
 */
export async function connectCallbackToOperator(requestId: string): Promise<CallbackConnectOutcome> {
  try {
    const request = await prisma.callbackRequest.findUnique({ where: { id: requestId } });
    if (!request || request.doneAt) return "closed";
    // Просьба из переписки — не оператору (22.09.2026), она ждёт агента в очереди.
    if (!isOperatorCallbackChannel(request.channel)) return "no_operator";

    // Вне рабочего времени не звоним никому: клиенту обещано «в рабочее время»,
    // и ночной звонок оператору разбудил бы его ради гудков.
    if (!(await isWithinWorkingHours())) return "off_hours";

    const operator = await loadDutyOperator();
    if (!operator) return "no_operator";
    // Оператор уже разговаривает — не выстраиваем ему вторую трубку. Запрос
    // остаётся в очереди, крон попробует следующим тиком.
    if (hasLiveCall(operator.id)) return "operator_busy";
    // Синхронная бронь (см. beginOrigination в callTracker.ts) — та же гонка,
    // что и у «Позвонить» из карточки: crontick и параллельная попытка соединить
    // того же оператора не должны обе проскочить hasLiveCall до первого trackCall.
    if (!beginOrigination(operator.id)) return "operator_busy";

    try {
      // Номер: из запроса, иначе из карточки клиента (она могла появиться позже
      // запроса — клиент продиктовал номер следующим сообщением).
      /**
       * УДАЛЁННАЯ КАРТОЧКА — НЕ ИСТОЧНИК НОМЕРА (27.08.2026).
       *
       * Между тем, как клиент попросил перезвонить, и тем, как крон дошёл до
       * его запроса, карточку могли отправить в Корзину. findFirst с
       * deletedAt: null, а не findUnique: набирать удалённого клиента и писать
       * звонок в его хронологию — то же самое, чего избегает markClientWroteHimself
       * (lib/clientMessageAlert.ts).
       */
      const client = request.clientId
        ? await prisma.client.findFirst({
            where: { id: request.clientId, deletedAt: null },
            select: { id: true, shortId: true, fullName: true, phone: true },
          })
        : null;
      // Запрос был привязан к карточке, но её больше нет — закрываем просьбу как
      // неактуальную вместо того, чтобы звонить по номеру из мёртвой записи.
      if (request.clientId && !client) {
        await prisma.callbackRequest.update({ where: { id: request.id }, data: { doneAt: new Date() } });
        return "closed";
      }
      const phone = request.phone?.trim() || client?.phone?.trim();
      if (!phone) return "no_phone";

      const creds = await loadAriCredentials();
      if (!creds) return "failed";

      const mode = await loadAgentDialMode();
      const { agentMobile } = await resolveAgentDialTarget(creds, operator.sipExtension, operator.phone, mode);

      // Имя клиента и тема — на трубке и в push: оператор снимает, уже зная, с кем
      // и о чём говорит, а не выясняет по ходу.
      const callerName = client?.fullName ?? "Клиент из переписки";
      const result = await originateCall(creds, operator.sipExtension, phone, {
        callerName,
        agentMobile,
      });
      if (!result.ok) {
        void logSystemError("telephony", `Обратный звонок не соединился: ${result.error ?? "originate failed"}`);
        return "failed";
      }

      // След в хронологии — ЕДИНСТВЕННАЯ запись на разговор: исход и запись допишет
      // обработчик событий АТС (callTracker), ровно как у звонка из карточки.
      if (client) {
        // Оператор реально набирает номер сам — legitimate agent-автор (П-10).
        const interaction = await logTimeline({
          clientId: client.id,
          actor: { kind: "agent", agentId: operator.id },
          type: "CALL",
          notes: `${CALLBACK_CALL_NOTE_PREFIX}: ${request.topic}`,
        });
        if (result.channelId) {
          trackCall({
            channelId: result.channelId,
            agentId: operator.id,
            clientId: client.id,
            clientShortId: client.shortId,
            clientName: client.fullName,
            dialingTo: agentMobile ?? operator.sipExtension,
            interactionId: interaction.id,
            agentExtension: operator.sipExtension,
            clientPhone: phone,
          });
        }
      }

      // Запрос закрывается фактом соединения: разговор уже идёт, и его след — в
      // хронологии звонков, а не в очереди просьб.
      await prisma.callbackRequest.updateMany({
        where: { id: request.id, doneAt: null },
        data: { doneAt: new Date(), doneById: operator.id },
      });

      void sendPushToAgent(operator.id, {
        title: "📞 Соединяю с клиентом",
        body: `${callerName}: ${request.topic}`,
        url: client ? `/clients/${client.id}` : "/messages",
      });

      return "connected";
    } finally {
      endOrigination(operator.id);
    }
  } catch (err) {
    void logSystemError("telephony", `Обратный звонок: сбой соединения: ${describeError(err)}`);
    return "failed";
  }
}

/** Возраст, после которого запрос не прозваниваем автоматически: через двое суток
 *  «сейчас позвоним» превращается в неожиданный звонок, который только раздражает.
 *
 *  Экспортируется, потому что этот же срок решает судьбу запроса в баннере
 *  (lib/callbackRequests.ts, closeSettledCallbackRequests): то, что уже никогда не
 *  прозвонится, не должно и висеть перед глазами. Два независимых числа разошлись бы
 *  молча — и в очереди появились бы запросы, которых никто не набирает. */
export const AUTO_CONNECT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Один тик крона: соединить САМЫЙ СТАРЫЙ подходящий запрос. Ровно один за тик —
 * оператор один, и пачка одновременных originate дала бы ему очередь из гудков.
 * Утром, когда наступает рабочее время, эта же задача сама разбирает ночную очередь.
 */
export async function autoConnectDueCallback(): Promise<CallbackConnectOutcome | "idle"> {
  const candidates = await prisma.callbackRequest.findMany({
    // Два условия, оба от владельца 22.09.2026, и они про разное:
    // byClientRequest — набираем только по прямой просьбе клиента (см.
    // recordCallbackRequest), заявки, выведенные ботом по итогу разговора, остаются
    // в очереди агентов; канал — просьбы из соцсетей и мессенджеров дежурному не
    // звонят вообще, даже если клиент попросил (см. OPERATOR_CALLBACK_CHANNELS).
    where: {
      doneAt: null,
      byClientRequest: true,
      requestedAt: { gte: new Date(Date.now() - AUTO_CONNECT_MAX_AGE_MS) },
      channel: { in: [...OPERATOR_CALLBACK_CHANNELS] },
    },
    orderBy: { requestedAt: "asc" },
    select: { id: true, clientId: true },
    // Небольшой запас: карточка могла уехать в Корзину, пока просьба ждала
    // очереди (27.08.2026) — без этого крон дозванивался бы до удалённых людей.
    // CallbackRequest.clientId — обычная строка без relation (см. schema.prisma),
    // отфильтровать удалённых одним запросом нельзя, поэтому берём с запасом и
    // проверяем карточки ниже.
    take: 20,
  });
  if (candidates.length === 0) return "idle";

  const clientIds = candidates.map((c) => c.clientId).filter((id): id is string => !!id);
  const liveIds = clientIds.length
    ? new Set(
        (await prisma.client.findMany({ where: { id: { in: clientIds }, deletedAt: null }, select: { id: true } })).map(
          (c) => c.id
        )
      )
    : new Set<string>();

  const oldest = candidates.find((c) => !c.clientId || liveIds.has(c.clientId));
  if (!oldest) return "idle";
  return connectCallbackToOperator(oldest.id);
}

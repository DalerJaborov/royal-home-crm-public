import { canReadInvestigations, investigationViewerRole } from "../../auth/investigations.js";
/**
 * Жизненный цикл лида/клиента: accept, decline, assign, bot-pause, transfer,
 * activate, refuse (Г2, §1.2). Перенос verbatim. (deactivate — ручной вход в
 * Неактивные — убран 16.09.2026, см. комментарий у /:id/activate ниже.)
 */
import { Router } from "express";
import {
  clientAssignSchema,
  botPauseSchema,
  clientRefuseSchema,
  clientTransferSchema,
  leadAcceptSchema,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission, scopeToOwnAgent } from "../../auth/middleware.js";
import { declineLead } from "../../leads.js";
import { acceptLead, LEAD_TAKEN_ERROR } from "../../lib/leadAccept.js";
import { transferClientByAgent, canTransferClient } from "../../lib/clientTransfer.js";
import { reactivateClient } from "../../lib/clientWorkStatus.js";
import { logAudit } from "../../lib/audit.js";
import { isDeferredReason, deferClient, returnDeferredClientManually } from "../../lib/deferredClients.js";
import { noteAgentHandoffAndAlarmIfAnomalous } from "../../lib/agentHandoffAnomalyAlarm.js";
import { refuseClient, checkRefusalPreconditions } from "../../lib/clientRefuse.js";
import { convertClientToJobApplication } from "../../lib/clientToCandidate.js";
import { deferredReturnMessage, foreignWriteDenied, presentClient } from "./shared.js";

import { publishClientUpdated } from "../../lib/livePublish.js";
import { assignClientManually } from "../../lib/assignClientManually.js";

export const lifecycleRouter = Router();

/**
 * Уровень 3: агент принимает лид — с этого момента открываются контакты и работа
 * с карточкой.
 *
 * Сама логика приёма живёт в lib/leadAccept.ts: тот же код обязан отрабатывать и
 * при нажатии кнопки прямо в шторке уведомлений, а два пути приёма с разной
 * логикой неминуемо разойдутся (окно «Итог разговора» заводилось бы только через
 * интерфейс). Здесь остались права и перевод исхода в HTTP.
 *
 * 409 requiresRelease — не ошибка, а вопрос: портфель полон, пришёл лид по
 * своему объекту, и агенту нужно выбрать, кого из обычных клиентов отдать
 * (решение владельца 11.08.2026). Интерфейс показывает список и возвращается
 * сюда с выбором.
 */
lifecycleRouter.post("/:id/accept", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  // Лид уже у другого агента — 409, а не 403 (23.09.2026). Нажатие «Принять»
  // без сети уходит из офлайн-очереди телефона позже, когда крон мог передать
  // лид дальше. 403 очередь считает «вход потерян» и встаёт, держа за этим
  // нажатием все прочие несохранённые действия агента (новые клиенты, заметки);
  // 409 она выбрасывает и идёт дальше. И текст честный: права у агента есть,
  // лида у него больше нет.
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(409).json({ error: LEAD_TAKEN_ERROR });
  }
  if (client.assignmentCompletedAt) {
    return res.status(409).json({ error: "Работа по назначению завершена — требуется новое назначение руководителем" });
  }
  if (client.acceptedAt) return res.json(presentClient(client, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));

  const parsedAccept = leadAcceptSchema.safeParse(req.body ?? {});
  if (!parsedAccept.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsedAccept.error.flatten() });
  }

  const outcome = await acceptLead({
    clientId: client.id,
    agentId: req.agent!.id,
    releaseClientId: parsedAccept.data.releaseClientId,
  });

  if (!outcome.ok && outcome.requiresRelease) {
    return res.status(409).json({
      requiresRelease: true,
      error: "Портфель полон — выберите, кого передать другому агенту",
      candidates: outcome.candidates,
    });
  }
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  logAudit(req, "LEAD_ACCEPT", "Client", client.id, {
    agentId: req.agent!.id,
    releasedClientId: outcome.releasedClientId ?? null,
  });

  const updated = await prisma.client.findUnique({ where: { id: client.id } });
  res.json(presentClient(updated ?? client, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});

/**
 * Агент отклонил новый лид (спецификация: кнопки «✅ Принять» / «❌ Отклонить»
 * рядом на карточке непринятого лида). Штрафует Royal Score по счётчику отказов
 * подряд и сразу передаёт лид следующему свободному агенту — вся логика в
 * leads.ts::declineLead, здесь только права и перевод результата в HTTP-ответ.
 */
lifecycleRouter.post("/:id/decline", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id }, select: { assignedAgentId: true, assignmentRefusedAt: true } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (client.assignmentRefusedAt) {
    return res.status(409).json({ error: "Отказ по этому назначению уже сохранён" });
  }
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(409).json({ error: LEAD_TAKEN_ERROR });
  }
  // Отклоняет только тот, кому лид отдан: отказ штрафует и считается в серию
  // отказов ВЛАДЕЛЬЦА — руководитель или служба безопасности, нажав «Отклонить»
  // на чужом лиде, штрафовали агента, который ничего не делал (аудит 23.09.2026, №39).
  if (client.assignedAgentId !== req.agent!.id) {
    return res.status(403).json({ error: "Отклонить лид может только тот, кому он отдан. Передать другому — кнопкой «Назначить»." });
  }

  const result = await declineLead(req.params.id, client.assignedAgentId);
  if (!result.ok) {
    if (result.reason === "not_found") return res.status(404).json({ error: "Клиент не найден" });
    if (result.reason === "already_accepted") {
      return res.status(409).json({ error: "Лид уже принят — отклонить его больше нельзя, используйте отказ от работы" });
    }
    return res.status(409).json({ error: LEAD_TAKEN_ERROR });
  }
  logAudit(req, "LEAD_DECLINE", "Client", req.params.id, {
    agentId: client.assignedAgentId,
    declineCount: result.declineCount,
    reassignedTo: result.reassignedTo,
    escalated: result.escalated,
    lost: result.lost,
  });
  // Лид отклонён: он ушёл из окна приёма у одного и появился у другого.
  publishClientUpdated({
    clientId: req.params.id,
    agentIds: [client.assignedAgentId, result.reassignedTo],
    actorId: req.agent!.id,
  });
  res.json(result);
});

/**
 * «В КАНДИДАТЫ» — перевести карточку клиента в раздел «Вакансии» (17.09.2026).
 *
 * Нужен для разгребания того, что уже случилось на проде: 302, 315, 319 пришли с
 * рекламы вакансии, а CRM завела их ПОКУПАТЕЛЯМИ с агентом — автоматика такие
 * карточки не тронет, потому что кандидатом их признал живой человек по телефону,
 * а не бот в переписке. Поэтому работает для любого типа карточки, в том числе с
 * назначенным агентом.
 *
 * Право то же, что у разбора очереди лидов (clients.assign): это решение
 * руководителя о чужой карточке, а не действие агента над своей. ПЛЮС раздел
 * «Вакансии» (vacancies.view, 02.10.2026): анкета с номером клиента уезжает
 * туда, и переводить в раздел, которого сам не видишь, некому. Оба права есть у
 * всех, кто нажимает кнопку сегодня (DIRECTOR, ADMIN, MANAGER), — никто её не
 * теряет. clients.delete сюда НЕ добавлен намеренно: у MANAGER его нет, а
 * кнопкой он пользуется — это решение владельца, а не правки (см. журнал
 * docs/journal/2026-10-02-perevod-v-kandidaty.md).
 *
 * 409 — у клиента есть незакрытая сделка или у продавца остались объекты.
 * С 02.10.2026 проверка идёт ДО любой записи: ничего не изменено, ни анкеты,
 * ни снятого агента, и текст ошибки говорит, что доделать руками.
 */
lifecycleRouter.post("/:id/to-candidate", requireAuth, requirePermission("clients.assign"), requirePermission("vacancies.view"), async (req, res) => {
  const result = await convertClientToJobApplication({ clientId: req.params.id, actorId: req.agent!.id });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  logAudit(req, "CLIENT_TO_CANDIDATE", "Client", req.params.id, { applicationId: result.applicationId });
  // Карточка ушла в Корзину — у того, кто её вёл, она должна пропасть с экрана
  // без перезагрузки, как при обычном удалении.
  publishClientUpdated({ clientId: req.params.id, actorId: req.agent!.id });
  res.json({ ok: true, applicationId: result.applicationId });
});

/** Руководитель разбирает непринятый/эскалированный лид: назначает его конкретному
 *  агенту вручную (или забирает себе с accept=true). Сбрасывает счётчик кругов и
 *  метку эскалации.
 *
 *  НАЗНАЧЕНИЕ РУКОВОДИТЕЛЕМ = ПРИНЯТО СРАЗУ (владелец 23.09.2026: «если директор
 *  или администратор назначает лид конкретному агенту, таймера нет, лид должен
 *  быть принят автоматически»). Раньше назначенный вручную лид снова вставал на
 *  15-минутный таймер принятия, и если агент не успевал — круг уводил его
 *  дальше, отменяя решение руководителя. Теперь `acceptedAt` ставится в той же
 *  записи, круг «не принял» карточку не видит, а агент узнаёт о ней пушем и
 *  строкой «Вам назначил руководитель» на Главной (routes/dashboard.ts,
 *  assignedBySupervisor). Обязанность первого звонка остаётся — это «позвоните
 *  клиенту», а не «примите заявку». */
lifecycleRouter.post("/:id/assign", requireAuth, requirePermission("clients.assign"), async (req, res) => {
  const parsed = clientAssignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  // Проверки, условная запись через changeClientAgent и всё, что после неё
  // (пуши, живые события, AuditLog LEAD_ASSIGN), — в lib/assignClientManually.ts:
  // ту же функцию зовёт ИИ-помощник (change_client_agent), копий нет.
  const outcome = await assignClientManually({
    clientId: req.params.id,
    toAgentId: parsed.data.agentId,
    accept: parsed.data.accept,
    actor: { id: req.agent!.id, role: req.agent?.role },
  });
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
  res.json(presentClient(outcome.client, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});

// POST /:id/claim-pool УДАЛЁН ЦЕЛИКОМ (17.09.2026, закон о владении клиентом
// П-4/Р-3 — `docs/law/lead-ownership.md`, `docs/audit/lead-ownership-17-09.md`
// §4). Пул «ничьих» добавлен 01.09.2026 по спецификации «гонка в пуле» —
// владелец этого не заказывал; правило прежнее: не принял за
// `leadAcceptMinutes` → следующему, у прежнего агента гаснут пуш и окно.
// `Client.poolCandidateIds` остаётся в схеме (миграции не делали), но больше
// никто его не читает и не пишет.

/** Оператор берёт диалог с ботом на себя — бот молчит до pausedUntil, чтобы не
 *  дублировать живого агента (pausedUntil=null снимает паузу). Работает во ВСЕХ каналах:
 *  Instagram/Facebook/WhatsApp живут в BotConversation, Telegram — в своей таблице,
 *  но для агента это один и тот же диалог с клиентом. */
lifecycleRouter.post("/:id/bot-pause", requireAuth, async (req, res) => {
  const parsed = botPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }

  const pausedUntil = parsed.data.pausedUntil ? new Date(parsed.data.pausedUntil) : null;
  // botPausedAt — с какого момента НАЧАЛАСЬ пауза (шаг 5 переноса, 10.09.2026):
  // снимается вместе с pausedUntil, ставится заново вместе с ним же.
  const botPausedAt = pausedUntil ? new Date() : null;

  // updateMany, не findUnique+update (19.08.2026) — у клиента теперь может быть
  // несколько диалогов бот-платформы разом; оператор, взявший клиента на себя,
  // ожидает, что бот замолчит ВЕЗДЕ, а не только в том канале, из которого
  // нажали паузу.
  //
  // Обе таблицы — одной транзакцией (23.09.2026). Раньше после Instagram/WhatsApp
  // стоял ранний выход, и до Telegram дело не доходило: у клиента с диалогами в
  // обоих мессенджерах бот в Telegram продолжал отвечать поверх агента, а снятие
  // паузы в Telegram не срабатывало.
  const [meta, telegram] = await prisma.$transaction([
    prisma.botConversation.updateMany({ where: { clientId: client.id }, data: { pausedUntil, botPausedAt } }),
    prisma.telegramConversation.updateMany({ where: { clientId: client.id }, data: { pausedUntil, botPausedAt } }),
  ]);
  if (meta.count + telegram.count === 0) {
    return res.status(404).json({ error: "У этого клиента нет диалога с ботом" });
  }
  return res.json({ pausedUntil });
});

/**
 * «Передача» (ТЗ п. 19-21, голосовое уточнение владельца 12.08.2026): агент решает
 * не продолжать вести клиента и объясняет почему; отличие от «Отказался»/«Без
 * сделки» — там причина про итог сделки, здесь про самого агента.
 *
 * Доступна только после первого проведённого показа: до этого момента передавать
 * ещё нечего (кнопка «Отказался»/эта же передача заменяет собой окно после
 * звонка/показа — там тот же результат достигается статусом ACTIVE/TRANSFER
 * внутри completeMeetingSummary; этот роут — для случая, когда агент решает
 * передать клиента НЕ в момент обязательного окна, а сам, из карточки).
 */
lifecycleRouter.post("/:id/transfer", requireAuth, async (req, res) => {
  const parsed = clientTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите причину передачи", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (client.kind !== "BUYER" || !client.assignedAgentId) {
    return res.status(409).json({ error: "Передача доступна только для покупателя с назначенным агентом" });
  }
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (ownAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  /**
   * ГЕЙТ ОТКРЫТ (мозговой штурм 20-21.08.2026, «рубеж 2: дверь передачи, которой
   * сейчас нет»): раньше требовался обязательно проведённый показ, теперь
   * достаточно хотя бы одной попытки реального контакта — см. документацию
   * canTransferClient. Показ по-прежнему пропускает сам, без доп. проверки.
   */
  const gate = await canTransferClient(client.id);
  if (!gate.allowed) return res.status(409).json({ error: gate.reason });

  const result = await transferClientByAgent({
    clientId: client.id,
    agentId: client.assignedAgentId,
    reason: parsed.data.reason,
    comment: parsed.data.comment,
    voiceNoteUrl: parsed.data.voiceNoteUrl,
    voiceNoteTranscript: parsed.data.voiceNoteTranscript,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  // logAudit("CLIENT_TRANSFER", ...) отсюда убран (22.08.2026): transferClientByAgent
  // теперь пишет ровно такую же запись сам, и делает это на ВСЕХ трёх входах
  // передачи (карточка клиента, «Итог показа», «Итог звонка»), а не только на
  // этом роуте — иначе счётчик квоты (Settings.transferQuotaPerMonth) занижал бы
  // передачи, сделанные через другие два роута, и «История» клиента дублировала
  // бы запись при передаче именно отсюда.
  res.json({ ok: true, message: result.lost ? "Клиент передан на решение руководства" : "Клиент передан следующему агенту" });
});

/**
 * POST /:id/deactivate УБРАН ЦЕЛИКОМ (владелец 16.09.2026): это был последний
 * живой вход в ручной перевод в Неактивные (DeactivateClientModal.tsx на
 * карточке). «Агент ничего никогда не делает кнопками, и самих кнопок для
 * этого нет» — автоматика (ai/callAnalysis.ts, lib/clientInactiveTextDetector.ts,
 * lib/silentClientAutoDeactivate.ts) вызывает deactivateClient()/
 * canDeactivateWithReason() из lib/clientWorkStatus.ts и lib/inactiveTrafficLight.ts
 * напрямую — они остаются нетронутыми, ушёл только HTTP-вход для агента.
 * Гашение требований при деактивации (было только здесь) перенесено внутрь
 * самой deactivateClient() — оба автоматических пути раньше его не получали
 * вовсе (см. комментарий там).
 */

/**
 * «Вернуть в работу» — обратный переход к «Неактивному» (ТЗ п. 27).
 *
 * Причин и полей не спрашиваем: возврат ничего не теряет и не передаёт, а лишний
 * обязательный текст на пути к работе с клиентом только мешает. Всё, что нужно
 * руководителю, и так остаётся в хронологии.
 */
lifecycleRouter.post("/:id/activate", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  // 06.09.2026: раньше требовало kind==="BUYER" — reactivateClient() ниже кинд не
  // проверяет вообще, но продавца, ушедшего в workStatus=INACTIVE (та же функция,
  // вызывается и для него — например, автодеактивацией за молчание), было НЕЧЕМ
  // вернуть обратно: единственная кнопка возврата отклонялась сервером. Найдено на
  // живом примере (продавец Хикоят) — карточка застряла «Неактивной» без выхода.
  if (!client.assignedAgentId) {
    return res.status(409).json({ error: "Возврат в работу доступен только клиенту с назначенным агентом" });
  }
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  const result = await reactivateClient({ clientId: client.id, agentId: client.assignedAgentId, actorAgentId: req.agent!.id });
  if (!result.ok) return res.status(409).json({ error: "Состояние или держатель карточки изменились — обновите карточку" });
  logAudit(req, "CLIENT_ACTIVATE", "Client", client.id, {});
  res.json({ ok: true });
});

/**
 * «Поднять раньше срока» (задача G5, план 03-04.09.2026) — агент, за которым
 * закреплён отложенный клиент, или руководитель (clients.assign) решают не
 * ждать таймер (Client.deferredUntil). В отличие от «Вернуть в работу» выше
 * (только для BUYER) — «Отложенные» бывают и у продавца (EXPENSIVE/WRONG_OBJECT/
 * FINANCE_ISSUE доступны обеим карточкам, см. selectableRefusalReasonsFor),
 * поэтому здесь kind не проверяем.
 */
lifecycleRouter.post("/:id/deferred/return", requireAuth, async (req, res) => {
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
  if (client.workStatus !== "DEFERRED") {
    return res.status(409).json({ error: "Клиент не в «Отложенных»" });
  }
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  const result = await returnDeferredClientManually(client.id, req.agent!.id);
  if (!result.ok) return res.status(404).json({ error: "Клиент не найден" });
  logAudit(req, "CLIENT_DEFERRED_RETURN", "Client", client.id, {});
  res.json({ ok: true });
});

/**
 * «Завершить сделку → Без сделки» (ТЗ п. 16-18, переработка 12.08.2026 из бывшей
 * кнопки «Отказался»/POST /clients/:id/refuse — путь тот же, назначение и правила
 * доступа обновлены).
 *
 * «Завершить сделку» доступна ТОЛЬКО после первого проведённого показа (ТЗ п. 16:
 * «это предотвращает фиктивное закрытие клиента без реальной работы») — раньше
 * было мягче: заполненная карточка тоже открывала отказ. До первого показа агент
 * закрывает клиента через «Неактивный» (POST /deactivate или тот же статус внутри
 * обязательного окна), не через этот роут. «Передача» тем же гейтом закрыта —
 * раньше здесь было написано обратное.
 *
 * Причина обязательна (REFUSAL_REASONS), комментарий обязателен всегда (решение
 * владельца 11.08.2026).
 *
 * Клиент становится ГОРЯЧИМ (hotSince, раздел «Горячие клиенты») — раз был показ,
 * условие «карточка заполнена ИЛИ был показ» всегда истинно по показу.
 *
 * Дальше лид уходит СИЛЬНОМУ агенту (максимальный KPI) как непринятый. После
 * третьего отказа передача останавливается и лид эскалируется руководству —
 * кружить дальше бессмысленно. Директору — ОТДЕЛЬНЫЙ пуш при любом неуспехе
 * (голосовое уточнение владельца 12.08.2026: «если сделка завершилась неуспешно,
 * пусть мне приходит уведомление»), не только при эскалации/СБ.
 */
lifecycleRouter.post("/:id/refuse", requireAuth, async (req, res) => {
  const parsed = clientRefuseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Укажите причину отказа", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (client.kind === "OTHER" || !client.assignedAgentId) {
    return res.status(409).json({ error: "У этого обращения нет агента — отказ ему не оформляется" });
  }
  if (ownAgentId && client.assignedAgentId !== ownAgentId) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  if (ownAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }

  /**
   * «ОТЛОЖЕННЫЕ» (задача G, план 03-04.09.2026, решение владельца) — EXPENSIVE/
   * FINANCE_ISSUE/WRONG_OBJECT перехватываются ЗДЕСЬ, ДО refuseClient: проверка
   * СБ и счётчик отказов к этому случаю не относятся — это обычный исход рынка,
   * не отказ и не передача. Карточка остаётся за тем же агентом
   * (workStatus=DEFERRED), слот освобождается, никто не звонит, refusalCount/
   * Royal Score не трогаем — см. lib/deferredClients.ts.
   *
   * ГЕЙТЫ «БЫЛ ПОКАЗ»/«КАРТОЧКА ЗАПОЛНЕНА» И ВЫСОКИЙ СКОРИНГ — ПО-ПРЕЖНЕМУ
   * ОБЯЗАТЕЛЬНЫ (найдено при интеграции 04.09.2026, тесты client-refuse.test.ts/
   * deferred-clients.test.ts). «Отложить» клиента, с которым не было ни показа,
   * ни заполненной карточки, — то самое фиктивное закрытие без работы (ТЗ п. 16),
   * просто через другую дверь, если гейт не проверить и здесь. deferClient сам
   * не гейтует (см. комментарий в lib/deferredClients.ts «гейты уже пройдены
   * вызывающим кодом») — checkRefusalPreconditions вынесен из refuseClient
   * именно для этого места.
   */
  if (isDeferredReason(parsed.data.reason)) {
    const pre = await checkRefusalPreconditions(client.id, parsed.data);
    if (!pre.ok) return res.status(pre.status).json({ error: pre.error });

    const deferred = await deferClient({
      clientId: client.id,
      agentId: client.assignedAgentId,
      reason: parsed.data.reason,
      initiator: parsed.data.initiator,
      comment: parsed.data.comment,
      competitorName: parsed.data.competitorName,
      voiceNoteUrl: parsed.data.voiceNoteUrl,
      voiceNoteTranscript: parsed.data.voiceNoteTranscript,
    });
    if (!deferred.ok) return res.status(409).json({ error: deferred.error });
    logAudit(req, "CLIENT_DEFER", "Client", client.id, { reason: parsed.data.reason, deferredUntil: deferred.deferredUntil });
    return res.json({
      ok: true,
      deferred: true,
      deferredUntil: deferred.deferredUntil,
      message: deferredReturnMessage(deferred.deferredUntil),
    });
  }

  /**
   * Бизнес-логика (гейты «был показ»/«карточка заполнена», проверка СБ, переход
   * следующему агенту, Royal Score, все пуши) — в lib/clientRefuse.ts, ОДНИМ
   * куском на кнопку агента и на детектор явного отказа в переписке
   * (lib/explicitRefusalDetector.ts, план 03.09.2026 §D). Здесь остаются только
   * права, зод-валидация и перевод результата в HTTP-ответ — status/LOST/показ/
   * карточка-заполнена проверяются ВНУТРИ refuseClient тоже (на случай гонки
   * между этой проверкой прав и вызовом функции), поэтому не дублируются здесь.
   */
  const agentIdBeforeRefuse = client.assignedAgentId;
  // actorId — кнопка агента, закон П-5 (см. комментарий у RefuseClientInput.actorId
  // в lib/clientRefuse.ts): без него общий сторож changeClientAgent (П-3) принял бы
  // саму кнопку за автоматику и мог бы ошибочно заблокировать передачу.
  // actorAgentId — кто реально нажал кнопку (П-10, 17.09.2026): обычно совпадает
  // с client.assignedAgentId, но не всегда — руководитель может оформить отказ
  // за чужого клиента (ownAgentId выше пуст только у него). Оба поля не входят
  // в zod-схему тела запроса, поэтому спред ...parsed.data их не перезапишет.
  const result = await refuseClient({
    clientId: client.id,
    ...parsed.data,
    actorId: req.agent!.id,
    actorAgentId: req.agent!.id,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  // meta расширена (03.09.2026, план §E): comment/initiator/competitorName/
  // voiceNoteUrl нужны недельной сводке СБ (routes/reports.ts,
  // GET /security-review-digest) — дословная цитата и ссылка на голосовую
  // заметку читаются прямо из AuditLog.meta, без повторного разбора Interaction.notes.
  // assignedAgentId — ОТДЕЛЬНО от штатного AuditLog.agentId («кто нажал кнопку»):
  // руководитель с правом clients.assign может оформить отказ по ЧУЖОЙ карточке
  // (foreignWriteDenied это разрешает), и тогда agentId записи — руководитель, а не
  // владелец портфеля. Разбивка по агентам в сводке СБ обязана считать по тому, чей
  // это был клиент, а не по тому, кто в моменте нажал кнопку.
  logAudit(req, "CLIENT_REFUSE", "Client", client.id, {
    reason: parsed.data.reason,
    refusalCount: result.refusalCount,
    isHot: result.isHot,
    nextAgentId: result.nextAgentId,
    initiator: parsed.data.initiator,
    comment: parsed.data.comment?.trim() || null,
    competitorName: parsed.data.competitorName?.trim() || null,
    voiceNoteUrl: parsed.data.voiceNoteUrl?.trim() || null,
    assignedAgentId: client.assignedAgentId,
  });

  // Счётчик аномалий F-2 (план 03-04.09.2026): закрытие с причиной NO_TRUST —
  // тот же человеческий повод, что и «Передать», просто второй путь (см.
  // документацию в agentHandoffAnomalyAlarm.ts). agentIdBeforeRefuse — исходный
  // агент, читан ДО refuseClient, а не после (после мог обнулиться, если карточка
  // ушла в общую очередь без нового исполнителя).
  if (parsed.data.reason === "NO_TRUST" && agentIdBeforeRefuse) {
    void noteAgentHandoffAndAlarmIfAnomalous({ agentId: agentIdBeforeRefuse, client, kind: "REFUSE_NO_TRUST" });
  }

  res.json({
    ok: true,
    isHot: result.isHot,
    refusalCount: result.refusalCount,
    transferred: result.transferred,
    ...(canReadInvestigations(req) ? { securityReview: result.securityReview } : {}),
    message: result.message,
  });
});

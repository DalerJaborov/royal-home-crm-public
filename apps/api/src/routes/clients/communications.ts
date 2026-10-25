/**
 * Связь с клиентом: message, message-voice, call, dial и originateCallToClient
 * (Г2, §1.2). Перенос verbatim. originateCallToClient экспортируется наружу
 * через баррель routes/clients.ts — внешний контракт сохранён.
 */
import { liveVoiceErrorForPerson } from "../../lib/telephony/liveVoiceUserError.js";
import { markAgentAttempt } from "../../lib/clientWorkStalled.js";
import { Router } from "express";
import { z } from "zod";
import { clientMessageSchema, CLIENT_PHONE_MASK_CHAR } from "@royal-home/shared";
import { maskClientPhone } from "../../lib/clientPhone.js";
import { prisma } from "../../db.js";
import { foreignWriteDenied } from "./shared.js";
import { canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { acceptLead } from "../../lib/leadAccept.js";
import {
  agentSender,
  deliverToConversation,
  deliverVoiceToConversation,
  resolveSendTarget,
} from "../../lib/conversationDelivery.js";
import { voiceMessageUpload } from "../../upload.js";
import {
  isDialableTajikNumber,
  loadAgentDialMode,
  loadAriCredentials,
  originateCall,
  resolveAgentDialTarget,
} from "../../lib/telephony/ariClient.js";
import { outgoingWhisper } from "../../lib/telephony/whisperSync.js";
import { beginOrigination, endOrigination, hasLiveCall, trackCall } from "../../lib/telephony/callTracker.js";
import { secondsUntilRedialAllowed } from "../../lib/telephony/agentNoPickupGuard.js";
import { findClientByPhoneDigits } from "../../lib/whatsappPhone.js";
import { phoneTail } from "../../lib/clientPhones.js";
import { findStaffPhone, staffPhoneError, STAFF_PHONE_ERROR_CODE } from "../../lib/staffPhoneGuard.js";
import { anyParams } from "../../lib/routeParams.js";
import { originateLiveVoiceCallToClient } from "../../lib/telephony/liveVoiceBridge.js";
import { manualRobotCallLimitReached, MANUAL_ROBOT_CALL_LIMIT_ERROR } from "../../lib/telephony/manualRobotCalls.js";
import { logAudit } from "../../lib/audit.js";
import { describeProperty } from "../../messengers/sharedMedia.js";
import { logTimeline } from "../../lib/timeline.js";
import { logSystemError } from "../../lib/systemError.js";
import { describeError } from "../../lib/describeError.js";

export const communicationsRouter = Router();

/**
 * Произвольное сообщение клиенту прямо из его карточки (решение владельца 30.07,
 * третий пакет п. 4: исход «ждёт варианты» должен давать агенту возможность
 * переписываться, а не только отправлять подобранные объекты).
 *
 * Живёт здесь, а не в инбоксе, по той же причине, что и отправка объектов: инбокс
 * закрыт правом messages.view, которого у рядового агента нет, а вести переписку со
 * СВОИМ клиентом он обязан уметь. Доступ — по назначенному агенту и принятому лиду.
 *
 * Транспорт, пауза бота, маскировка телефонов и запись в историю — общие с инбоксом
 * (lib/conversationDelivery.ts).
 */
communicationsRouter.post("/:id/message", requireAuth, async (req, res) => {
  const parsed = clientMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Писать клиенту от имени агентства — это правка чужой карточки: сообщение
  // глушит бота. «Видеть все» (служба безопасности) права писать не даёт; в
  // Корзине переписки нет (аудит 23.09.2026, №40).
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  if (client.deletedAt) return res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });
  if (ownAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  // Диалог, выбранный вкладкой канала в карточке; без него — самый живой. Чужой
  // или несуществующий id — ошибка интерфейса: молча слать в другой диалог нельзя.
  const target = await resolveSendTarget(client.id, parsed.data.conversationId);
  if (target === undefined) return res.status(404).json({ error: "Диалог не найден у этого клиента" });
  if (!target) {
    return res.status(409).json({
      error: "Клиент не писал в мессенджер — написать ему отсюда нельзя. Позвоните или напишите сами.",
    });
  }

  const delivery = await deliverToConversation(target, parsed.data.text, undefined, {
    learnFromOverride: true,
    sender: await agentSender(req.agent!.id),
  });
  if (!delivery.ok) {
    return res.status(delivery.status).json({ error: delivery.error, code: delivery.code });
  }

  res.json({ ok: true, masked: delivery.masked, pausedUntil: delivery.pausedUntil });
});

/**
 * Голосовое из карточки клиента — тот же круг доступа, что и «Написать клиенту»
 * (POST /:id/message), и та же причина завести отдельно от инбокса: рядовой агент
 * инбокс не видит, а переписываться со СВОИМ клиентом обязан уметь.
 */
communicationsRouter.post("/:id/message-voice", requireAuth, anyParams(voiceMessageUpload.single("audio")), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });
  // Диалог, выбранный вкладкой канала (поле multipart), необязателен.
  const conversationId = z.string().trim().min(1).max(80).optional().safeParse(req.body?.conversationId);
  if (!conversationId.success) return res.status(400).json({ error: "Неверные данные" });

  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Писать клиенту от имени агентства — это правка чужой карточки: сообщение
  // глушит бота. «Видеть все» (служба безопасности) права писать не даёт; в
  // Корзине переписки нет (аудит 23.09.2026, №40).
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  if (client.deletedAt) return res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });
  if (ownAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  const target = await resolveSendTarget(client.id, conversationId.data);
  if (target === undefined) return res.status(404).json({ error: "Диалог не найден у этого клиента" });
  if (!target) {
    return res.status(409).json({
      error: "Клиент не писал в мессенджер — написать ему отсюда нельзя. Позвоните или напишите сами.",
    });
  }

  const delivery = await deliverVoiceToConversation(
    target,
    { buffer: req.file.buffer },
    {
      sender: await agentSender(req.agent!.id),
      clientId: client.id,
      clientName: client.fullName,
    }
  );
  if (!delivery.ok) {
    return res.status(delivery.status).json({ error: delivery.error, blocked: delivery.blocked ?? false, code: delivery.code });
  }
  res.json({ ok: true, pausedUntil: delivery.pausedUntil });
});

/**
 * Общая часть звонка «клиенту» (ARI Originate) — используется и из карточки
 * (POST /:id/call), и из ручного набора (POST /dial, ниже): вторая кнопка
 * появилась именно потому, что первая требует УЖЕ существующую карточку, а
 * оператор на входящем часто набирает номер, которого в базе ещё нет.
 *
 * Требует Agent.sipExtension у звонящего (см. docs/telephony-sip-numbering.md) и
 * настроенные креды ARI в Settings. Любое из двух отсутствует — понятная ошибка,
 * а не голый 500: страница «Ключи» уже умеет объяснять «Телефония не настроена».
 */
export async function originateCallToClient(
  agentId: string,
  client: { id: string; shortId: number; phone: string; fullName: string },
  options?: {
    /** Принудительный режим дозвона ИМЕННО для этого звонка — не трогает
     *  общую настройку asteriskAgentDialMode. См. POST /me/active-call/retry-mobile. */
    forceMode?: "mobile";
    /** Этот звонок продолжает другой (плохая связь, переключение на мобильный
     *  посреди разговора) — см. Interaction.continuesInteractionId. */
    continuesInteractionId?: string;
    /** Звонок НЕ на основной client.phone, а на другой номер этого же клиента
     *  (WhatsApp-номер, запасной номер) — владелец 20.08.2026, живой случай:
     *  основной номер оказался недоступен, а WhatsApp-номер — рабочий. Роут
     *  /:id/call сам проверяет, что номер и правда принадлежит этому клиенту
     *  и что его в принципе можно набрать (isDialableTajikNumber) — сюда
     *  приходит уже проверенным. */
    phoneOverride?: string;
  }
): Promise<
  | { ok: true; channelId: string | undefined; dialing: { to: string; mode: "mobile" | "extension" } }
  | { ok: false; status: number; error: string }
> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { sipExtension: true, phone: true, whisperLanguage: true, fullName: true },
  });
  if (!agent?.sipExtension) {
    // В журнал ошибок, а не только агенту (28.09.2026, «Сурайё не смогла
    // дозвониться»): отказ по настройке видел один агент в красной плашке, а
    // директор на экране «Здоровье системы» — ничего. Ключ дедупа по агенту:
    // одна строка на сотрудника, сколько бы раз он ни нажимал.
    void logSystemError("telephony", `У сотрудника ${agent?.fullName ?? agentId} нет внутреннего номера — исходящие звонки из CRM у него не проходят`, {
      dedupKey: `no-sip-extension:${agentId}`,
    });
    return { ok: false, status: 409, error: "У вас не настроен внутренний номер (SIP) — обратитесь к директору" };
  }

  // Второй звонок, не закончив первый, начать нельзя — как с обычным телефоном.
  // Иначе станция звонила бы агенту на ту же трубку, занятую разговором, и он
  // получал бы «занято» от самого себя.
  if (hasLiveCall(agentId)) {
    return { ok: false, status: 409, error: "У вас уже идёт звонок — завершите его, прежде чем начать новый" };
  }

  /**
   * БРОНЬ ДО ПЕРВОГО AWAIT (найдено ревью 19.08.2026). hasLiveCall выше видит
   * живой звонок только ПОСЛЕ trackCall в конце функции — а между этой
   * проверкой и той записью несколько await (ARI-креды, resolveAgentDialTarget,
   * originateCall, запись Interaction). Двойной клик или повторный запрос после
   * медленного ответа успевает пройти обе проверки до первого trackCall и
   * уводит агенту два живых канала разом. beginOrigination — синхронная бронь,
   * ставится и проверяется в одном тике event loop, гонки в ней нет.
   */
  if (!beginOrigination(agentId)) {
    return { ok: false, status: 409, error: "У вас уже идёт звонок — завершите его, прежде чем начать новый" };
  }

  try {
    const creds = await loadAriCredentials();
    if (!creds) {
      // Та же причина, что у пустого внутреннего номера выше: без ключей не
      // звонит НИКТО, и об этом обязан узнать директор, а не только тот, кто нажал.
      void logSystemError("telephony", "Ключи ARI не заданы или не читаются — ни один исходящий звонок из CRM не проходит", {
        dedupKey: "ari-credentials-missing",
      });
      return { ok: false, status: 409, error: "Телефония не настроена — нет ключей ARI в Настройках" };
    }

    /**
     * Куда звонить самому сотруднику. Внутренний номер обязателен в любом режиме: он
     * остаётся определителем сотрудника на АТС, и по нему считается, чей это звонок.
     *
     * В режиме «авто» станция спрашивается о состоянии аппарата: есть трубка на связи —
     * плечо внутреннее и бесплатное, нет — звоним на мобильный (см. resolveAgentDialTarget).
     */
    const mode = options?.forceMode ?? (await loadAgentDialMode());
    const { agentMobile, effectiveMode: dialMode } = await resolveAgentDialTarget(
      creds,
      agent.sipExtension,
      agent.phone,
      mode
    );

    /**
     * ПОДСКАЗКА ПЕРЕД НАБОРОМ. На исходящих она по умолчанию выключена — агент сам
     * выбрал, кому звонит, и имя клиента уже светится у него на трубке (callerName
     * ниже). Включают её ради другого случая: звонка из списка задач, когда человек
     * набрал номер по напоминанию и уже не помнит, о чём был разговор.
     *
     * null (выключено, файл ещё не озвучен, контекста на станции нет) означает
     * обычный звонок прежним путём — исходящий важнее любой подсказки.
     */
    const whisper = await outgoingWhisper({
      clientId: client.id,
      agentWhisperLanguage: agent.whisperLanguage,
    }).catch(() => null);

    // Звоним на переопределённый номер (WhatsApp/запасной), если он передан и уже
    // проверен роутом, иначе — на основной. Имя клиента на трубке агента: он берёт
    // её, уже зная, с кем говорит, и не ищет карточку на ходу. Наружу это имя не
    // уходит — исходящий маршрут подменяет определитель на номер агентства.
    const dialedPhone = options?.phoneOverride ?? client.phone;
    const result = await originateCall(creds, agent.sipExtension, dialedPhone, {
      callerName: client.fullName,
      agentMobile,
      whisper: whisper ?? undefined,
    });
    if (!result.ok) {
      return { ok: false, status: 502, error: result.error ?? "Не удалось совершить звонок" };
    }
    /**
     * СЛЕД В ХРОНОЛОГИИ КЛИЕНТА. Запись заводится сразу по факту команды и остаётся
     * ЕДИНСТВЕННОЙ на разговор: когда звонок закончится, обработчик событий АТС
     * (lib/telephony/callTracker.ts) допишет в неё исход и длительность, а следом
     * привяжет файл записи и расшифровку. Две записи на один разговор читались бы как
     * два звонка и портили бы и хронологию, и счёт агента.
     */
    const interaction = await logTimeline({
      clientId: client.id,
      actor: { kind: "agent", agentId },
      type: "CALL",
      notes: options?.continuesInteractionId
        ? "Звонок продолжен через мобильный — плохая связь в браузере"
        : options?.phoneOverride
          ? `Звонок инициирован из CRM на дополнительный номер (${options.phoneOverride})`
          : "Звонок инициирован из CRM",
      continuesInteractionId: options?.continuesInteractionId,
    });

    if (result.channelId) {
      // С этого момента звонок «живой»: его состояние обновляется событиями с АТС
      // и видно агенту на экране вызова. trackCall делает hasLiveCall истинным —
      // дальше вести агента от повторного набора уже её работа, бронь своё сделала.
      trackCall({
        channelId: result.channelId,
        agentId,
        clientId: client.id,
        clientShortId: client.shortId,
        clientName: client.fullName,
        dialingTo: agentMobile ?? agent.sipExtension,
        interactionId: interaction.id,
        agentExtension: agent.sipExtension,
        // Набранный номер, а не обязательно client.phone: плечо клиента дальше
        // узнаётся сравнением с НАБРАННЫМ номером (classifyDialLeg в ariEvents.ts),
        // а не с полем карточки — при звонке на переопределённый номер это разные
        // строки, и сравнение с client.phone не опознало бы ответ клиента вовсе.
        clientPhone: dialedPhone,
      });
    }

    return { ok: true, channelId: result.channelId, dialing: { to: agentMobile ?? agent.sipExtension, mode: dialMode } };
  } finally {
    endOrigination(agentId);
  }
}

/**
 * Звонок из карточки клиента — тот же круг доступа, что и «Написать клиенту»
 * (POST /:id/message): доступ к самой карточке через canAccessAssignedAgent, без
 * отдельного права. Звонить — не более чувствительное действие, чем писать, а
 * плодить право ради одной кнопки, которая по факту всегда включена рядом с уже
 * закрытой карточкой, лишний слой без пользы.
 */
const callBodySchema = z.object({
  /** Звонок НЕ на основной телефон, а на другой номер этой же карточки —
   *  WhatsApp-номер или один из «запасных» (владелец 20.08.2026, живой случай:
   *  основной номер оказался недоступен, WhatsApp — рабочий). Провалидирован
   *  ниже: обязан принадлежать ИМЕННО этой карточке и быть таджикским номером —
   *  иначе транк звонок не наберёт, а звонить мимо этой карточки чужому номеру
   *  через эту кнопку нельзя (для этого есть отдельный «Набрать номер»). */
  phone: z.string().min(5).max(30).optional(),
});

communicationsRouter.post("/:id/call", requireAuth, async (req, res) => {
  const parsed = callBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверный номер" });

  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      shortId: true,
      assignmentCompletedAt: true, assignedAgentId: true,
      phone: true,
      fullName: true,
      whatsappPhone: true,
      extraPhones: true,
      acceptedAt: true,
      kind: true,
      deletedAt: true,
    },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Звонок — тоже действие от имени сотрудника, тот же круг, что и «Написать
  // клиенту» (аудит 24.09.2026, №121): «видеть все» (служба безопасности) не
  // даёт звонить чужому клиенту, а звонок из Корзины бессмысленен — карточку
  // сначала восстанавливают.
  {
    const denied = foreignWriteDenied(req, client, scopeToOwnAgent(req));
    if (denied) return res.status(403).json({ error: denied });
  }
  if (client.deletedAt) return res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });

  /**
   * ТРОТТЛИНГ ПОВТОРНОГО НАБОРА ПОСЛЕ AGENT_NO_PICKUP (24.09.2026, найдено
   * ревью: кнопка «Позвонить» позволяла тут же набрать ту же карточку заново,
   * хотя станция ещё не успела дозвониться агенту с прошлой попытки — см.
   * lib/telephony/agentNoPickupGuard.ts). 429, а не тихий повторный набор:
   * агент должен понять, что дело не в клиенте, а в его собственном телефоне.
   */
  const redialWaitSeconds = secondsUntilRedialAllowed(client.id, req.agent!.id);
  if (redialWaitSeconds > 0) {
    // Retry-After обязателен (28.09.2026): без него сайт брал срок из
    // RateLimit-Reset общего лимитера — «подождите 240 с» вместо честных 30, и
    // текст этой строки до агента не доходил вовсе (lib/api.ts, ветка 429).
    res.set("Retry-After", String(redialWaitSeconds));
    return res
      .status(429)
      .json({ error: `Подождите ${redialWaitSeconds} с: предыдущий вызов не дошёл до вашего телефона` });
  }

  /**
   * «ЗВОНОК = ПРИНЯТИЕ» (владелец 01.09.2026, срочный запрос — достроить весь
   * оставшийся список Логики 2.0). Раньше это были два раздельных действия:
   * сначала кнопка «Принять», потом «Позвонить»; агент мог звонить и до приёма (маршрут никогда не
   * блокировал это — сервер сам берёт client.phone, номер агенту не виден), но
   * карточка формально висела «не принята», пока он не возвращался нажать
   * отдельную кнопку. Здесь — тот же самый, уже проверенный `acceptLead`
   * (routes/clients/lifecycle.ts::/:id/accept), просто вызванный ПЕРЕД набором,
   * а не вместо кнопки: она остаётся рабочей для случаев без звонка (сначала
   * написали, потом решили принять) и для явного «нет, пока не звоню».
   *
   * Fail-open по дизайну: если приём не удался (портфель полон и нужен выбор
   * агента, кого освободить — `requiresRelease`), звонок всё равно происходит,
   * карточка остаётся «не принята» как раньше. Блокировать сам звонок из-за
   * лимита портфеля значило бы отбирать у агента возможность поговорить с
   * человеком, который прямо сейчас на линии, — ради административной проверки,
   * которая подождёт до конца разговора.
   */
  const ownAgentIdForAccept = scopeToOwnAgent(req);
  if (ownAgentIdForAccept && !client.acceptedAt && client.kind !== "OTHER" && client.assignedAgentId === ownAgentIdForAccept) {
    await acceptLead({ clientId: client.id, agentId: ownAgentIdForAccept }).catch((err) =>
      console.error("[leadAccept] автопринятие по звонку:", err)
    );
  }

  /**
   * ЗАПАСНОЙ НОМЕР ПРИХОДИТ МАСКОЙ — И ЭТО НЕ ПОВОД НЕ ЗВОНИТЬ (владелец 30.08.2026).
   *
   * Агенту без права `clients.viewPhone` карточка отдаёт `+992•••••57` вместо цифр
   * (presentClient). Кнопка «Позвонить» на ОСНОВНОЙ номер это переживала — сервер
   * берёт `client.phone` по clientId сам, — а вот кнопка на ЗАПАСНОЙ слала цифры
   * обратно, и они приходили сюда маской: проверка принадлежности не проходила,
   * и позвонить на второй номер клиента агент не мог вовсе. Тот самый случай, из-за
   * которого агенты и выпрашивали номер у коллег — то есть правило подталкивало
   * ровно к тому, что запрещает.
   *
   * Опознаём маску по её же виду и разворачиваем в настоящий номер сравнением с
   * номерами ЭТОЙ карточки. Наружу цифры при этом не уходят: агент отправил то, что
   * ему и так показали, а набирает станция.
   */
  const knownPhones = [client.phone, ...(client.whatsappPhone ? [client.whatsappPhone] : []), ...client.extraPhones];
  const requestedPhone = parsed.data.phone?.includes(CLIENT_PHONE_MASK_CHAR)
    ? knownPhones.find((p) => maskClientPhone(p) === parsed.data.phone)
    : parsed.data.phone;
  if (parsed.data.phone && !requestedPhone) {
    return res.status(400).json({ error: "Этот номер не принадлежит карточке клиента" });
  }

  let phoneOverride: string | undefined;
  if (requestedPhone) {
    const requestedTail = phoneTail(requestedPhone);
    const knownTail = requestedTail === phoneTail(client.phone) || requestedTail === phoneTail(client.whatsappPhone ?? "");
    const matchesExtra = client.extraPhones.some((p) => phoneTail(p) === requestedTail);
    if (!knownTail && !matchesExtra) {
      return res.status(400).json({ error: "Этот номер не принадлежит карточке клиента" });
    }
    if (!isDialableTajikNumber(requestedPhone)) {
      return res.status(400).json({ error: "Номер не таджикский — станция не сможет его набрать" });
    }
    // Совпал с основным — override не нужен, звоним обычным путём.
    if (requestedTail !== phoneTail(client.phone)) phoneOverride = requestedPhone;
  }

  const result = await originateCallToClient(req.agent!.id, client, { phoneOverride });
  if (!result.ok) {
    /**
     * СТАНЦИЯ ОТКАЗАЛА — ЭТО ПОПЫТКА АГЕНТА, А НЕ ЕГО ВИНА (владелец 29.09.2026:
     * «таймер 15 минут должен отключаться, это вина станции, а не агента»).
     * 502 — originateCall не достучался до станции или та отказала. Агент нажал
     * «Позвонить» — отметка попытки (lastAgentAttemptAt) закрывает обязанность
     * первого звонка тем же путём, что сообщение клиенту из CRM
     * (services/leads/firstCall.ts, collectFirstCallFacts): таймер на экране
     * гаснет, штрафа и передачи лида нет. Только своему клиенту — byAgentId.
     */
    if (result.status === 502) await markAgentAttempt(client.id, new Date(), req.agent!.id);
    return res.status(result.status).json({ error: result.error });
  }

  // Куда пошёл вызов — агенту видно сразу. Первый живой звонок 07.08.2026 «пропал»
  // именно из-за этого: в карточке сотрудника стоял выдуманный номер из тестовых
  // данных, станция честно набрала его и никого не нашла, а CRM отвечала «Сохранено».
  res.json({ ok: true, channelId: result.channelId, dialing: result.dialing });
});

/** Роли, которым доступен «Звонок роботом» (совпадает с isSupervisor в ClientDetail). */
const LIVE_VOICE_ROLES: string[] = ["ADMIN", "DIRECTOR", "MANAGER", "HEAD_OF_SALES"];

const liveVoiceCallSchema = z.object({
  propertyId: z.string().uuid().optional(),
});

/**
 * ЗВОНОК ЖИВЫМ ГОЛОСОМ ЭТОМУ КЛИЕНТУ (13.09.2026, разбор «заменить оператора» —
 * docs/TASKS.md). В отличие от POST /:id/call выше, звонит НЕ агент — звонит бот
 * (originateLiveVoiceCallToClient, lib/telephony/liveVoiceBridge.ts), с полным
 * знанием объекта, если он передан. Права — те же, что у обычного звонка
 * (canAccessAssignedAgent): бот звонит от имени того же круга людей, кому вообще
 * можно звонить этому клиенту, а не только владельцу.
 */
communicationsRouter.post("/:id/live-voice-call", requireAuth, async (req, res) => {
  // Только руководство (владелец 29.09.2026): робот звонит клиенту от имени
  // агентства, клиент такого звонка не ждёт — рядовому агенту эта кнопка не
  // нужна. Круг тот же, что у кнопки «Назначить агента» в карточке.
  if (!LIVE_VOICE_ROLES.includes(req.agent!.role)) {
    return res.status(403).json({ error: "Звонок роботом доступен только руководителю" });
  }
  const parsed = liveVoiceCallSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Неверный запрос" });

  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    select: { id: true, shortId: true, assignmentCompletedAt: true, assignedAgentId: true, phone: true, fullName: true, deletedAt: true, acceptedAt: true },
  });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
  if (!canAccessAssignedAgent(req, client.assignedAgentId)) {
    return res.status(403).json({ error: "Недостаточно прав" });
  }
  // Тот же круг, что у обычного звонка и «Написать клиенту» (аудит 24.09.2026,
  // №121): «видеть все» не даёт звонить чужому клиенту, звонок в Корзину
  // бессмыслен, а непринятому лиду бот звонить не должен — карточка ещё
  // закрыта до принятия.
  const ownAgentId = scopeToOwnAgent(req);
  {
    const denied = foreignWriteDenied(req, client, ownAgentId);
    if (denied) return res.status(403).json({ error: denied });
  }
  if (client.deletedAt) return res.status(409).json({ error: "Карточка в Корзине — сначала восстановите её" });
  if (ownAgentId && !client.acceptedAt) {
    return res.status(403).json({ error: "Сначала примите лид — до принятия карточка закрыта" });
  }

  let propertyDescription: string | null = null;
  if (parsed.data.propertyId) {
    const property = await prisma.property.findUnique({
      where: { id: parsed.data.propertyId },
      select: {
        rooms: true,
        type: true,
        areaSqm: true,
        price: true,
        currency: true,
        status: true,
        shortId: true,
        district: { select: { name: true } },
      },
    });
    if (!property) return res.status(404).json({ error: "Объект не найден" });
    propertyDescription = describeProperty(property);
  }

  // Суточный предел на сотрудника и след в журнале (02.10.2026,
  // lib/telephony/manualRobotCalls.ts): кто, кому и с каким исходом звонил роботом.
  if (await manualRobotCallLimitReached(req.agent!.id)) {
    return res.status(429).json({ error: MANUAL_ROBOT_CALL_LIMIT_ERROR });
  }
  const result = await originateLiveVoiceCallToClient(client, propertyDescription);
  logAudit(req, "LIVE_VOICE_CALL_CLIENT", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    phone: maskClientPhone(client.phone),
    propertyId: parsed.data.propertyId ?? null,
    ok: result.ok,
    channelId: result.channelId ?? null,
    error: result.error?.slice(0, 300) ?? null,
  });
  if (!result.ok) return res.status(409).json({ error: liveVoiceErrorForPerson(result.error) });
  /**
   * СЛЕД В ХРОНОЛОГИИ КАРТОЧКИ (02.10.2026, аудит роботов №4). Окно в карточке
   * обещало запись в хронологии, а её не заводил никто: остаются только сессия
   * живого голоса и обращение, менеджер не находил следа и звонил снова. Звонок
   * по карточке идёт без task/onFinished (мост, liveVoiceBridge.ts, итога в
   * хронологию не пишет), поэтому здесь заводится запись о ЗАПУСКЕ; расшифровка и
   * запись разговора — в «Звонки → Живой голос». Тип SYSTEM и автор system, а не
   * CALL от менеджера: набранный роботом и не снятый звонок не должен считаться
   * контактом сотрудника с клиентом (счёт звонков, таймеры «без движения»).
   * Звонок уже уходит — отказ записи не должен превращаться в 500 для кнопки.
   */
  try {
    await logTimeline({
      clientId: client.id,
      actor: { kind: "system", source: "live-voice-card-call" },
      type: "SYSTEM",
      notes: parsed.data.propertyId
        ? "Звонок роботом по кнопке в карточке: робот набирает клиента, разговор по объекту."
        : "Звонок роботом по кнопке в карточке: робот набирает клиента.",
      propertyId: parsed.data.propertyId ?? null,
    });
  } catch (err) {
    void logSystemError(
      "telephony",
      `Звонок роботом по карточке ${client.shortId}: запись в хронологию не легла: ${describeError(err)}`
    );
  }
  res.json({ ok: true, channelId: result.channelId });
});

const dialSchema = z.object({
  // 9–15 цифр (с кодом страны и без) — та же терпимость к записи, что и у
  // остального ввода телефона в CRM; лишнее (пробелы, скобки, дефисы) отсекается
  // ниже перед поиском и набором, а не здесь.
  phone: z.string().min(5).max(30),
});

/**
 * РУЧНОЙ НАБОР НОМЕРА (владелец 11.08.2026: «а если надо набрать номер?»).
 *
 * Кнопка «Позвонить» есть только там, где уже есть карточка клиента — а прямо
 * во время разговора или сразу после нужно набрать номер, которого в базе, может,
 * ещё нет вовсе (клиент дал другой контакт, риелтор с другого агентства,
 * поставщик). Заставлять сначала открыть форму «Новый клиент» ради одного звонка
 * означало бы, что звонить руками в обход CRM (без записи, без хронологии)
 * остаётся единственным быстрым путём — то есть путём, который и так уже есть.
 *
 * НАЙТИ ИЛИ ЗАВЕСТИ КАРТОЧКУ, А НЕ ЗВОНИТЬ МИМО CRM. Тот же принцип, что у
 * входящих (см. lib/telephony/incomingCalls.ts createCardForUnknownCaller):
 * звонок без карточки некуда записать. Разница с входящим — здесь НАЗНАЧАЕМ
 * ответственного сразу: оператор поднял трубку и осознанно набрал этот номер
 * сам, это не «неизвестно кто разберёт» входящего звонка. Найденному клиенту
 * ответственного не меняем — только звоним по обычному правилу доступа.
 */
communicationsRouter.post("/dial", requireAuth, async (req, res) => {
  const parsed = dialSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Введите номер телефона" });
  }
  const digits = parsed.data.phone.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 5) {
    return res.status(400).json({ error: "Слишком короткий номер" });
  }

  const existing = await findClientByPhoneDigits(digits);
  let client: { id: string; shortId: number; phone: string; fullName: string; assignedAgentId: string | null };

  if (existing) {
    // В Корзине или нет — звоним в любом случае: номер настоящий, блокировать
    // сам звонок из-за состояния карточки смысла не имеет (владелец 18.08.2026:
    // «очень странная логика», звонок не проходил вовсе). Карточку из Корзины
    // при этом НЕ восстанавливаем молча — это по-прежнему решение человека, а
    // не побочный эффект нажатия «Набрать»; создать новую карточку с тем же
    // номером тоже нельзя (phone уникален), так что звонок просто привязывается
    // к существующей записи, какой бы она ни была.
    const full = await prisma.client.findUniqueOrThrow({
      where: { id: existing.id },
      select: { id: true, shortId: true, phone: true, fullName: true, assignedAgentId: true, assignmentCompletedAt: true },
    });
    if (!canAccessAssignedAgent(req, full.assignedAgentId)) {
      return res.status(403).json({ error: "Этот номер уже принадлежит другому клиенту — недостаточно прав" });
    }
    // Тот же класс, что и у кнопки «Позвонить» из карточки (аудит 24.09.2026,
    // №121): право «видеть всех» (служба безопасности) проходит проверку выше
    // молча, но звонить чужому клиенту оно не даёт — только закреплённый агент
    // или тот, кто распределяет лидов. Состояние Корзины здесь по-прежнему НЕ
    // проверяем — решение владельца 18.08.2026 выше по файлу, этого фикс не
    // трогает.
    {
      const denied = foreignWriteDenied(req, full, scopeToOwnAgent(req));
      if (denied) return res.status(403).json({ error: denied });
    }
    client = full;
  } else {
    // Номер сотрудника — карточку не заводим вовсе, даже под ручной набор
    // (см. lib/staffPhoneGuard.ts). Существующую карточку выше это не трогает:
    // легаси-запись, если она уже есть, звонок не блокирует.
    const staffMatch = await findStaffPhone([digits]);
    if (staffMatch) {
      return res.status(409).json({ error: staffPhoneError(staffMatch), code: STAFF_PHONE_ERROR_CODE });
    }
    client = await prisma.client.create({
      data: {
        /**
         * ИМЯ-ЗАГЛУШКА, А НЕ НОМЕР (владелец 30.08.2026).
         *
         * Здесь стояло `fullName: digits` — карточка навсегда называлась открытым
         * номером, и он ехал в каждый список, где имя показывается без разбора
         * прав. Ровно тот же случай, что с именами входящих «Входящий +992…»
         * (lib/telephony/incomingCalls.ts): маскировка поля `phone` такое имя не
         * трогает, потому что номер лежит не в том поле. Две последние цифры
         * оставляем по той же причине, что и в маске: отличить две подряд
         * набранные карточки. Сам номер живёт в `phone` и открывается правом.
         */
        fullName: `Исходящий ***${digits.replace(/\D/g, "").slice(-2)}`,
        phone: digits,
        source: "PHONE_CALL",
        kind: "OTHER",
        status: "NEW",
        currency: "TJS",
        assignedAgentId: req.agent!.id,
      },
      select: { id: true, shortId: true, phone: true, fullName: true, assignedAgentId: true },
    });
  }

  const result = await originateCallToClient(req.agent!.id, client);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({
    ok: true,
    channelId: result.channelId,
    dialing: result.dialing,
    client: { id: client.id, shortId: client.shortId, fullName: client.fullName },
  });
});

import { canReadInvestigations } from "../../auth/investigations.js";
import { canViewInvestigations } from "@royal-home/shared";
/**
 * Хронология: POST /:id/interactions и решение СБ POST /:id/security-review
 * (Г2, §1.2). Перенос verbatim.
 */
import { Router } from "express";
import { syncLegacyInvestigationVerdict } from "../../lib/investigationCases.js";
import {
  interactionCreateSchema,
  securityReviewSchema,
  SECURITY_REVIEW_LABELS,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission, scopeToOwnAgent } from "../../auth/middleware.js";
import { clientNamePhoneSafe } from "../../lib/clientPhone.js";
import { logAudit } from "../../lib/audit.js";
import { notifyNoAnswerEscalation, planNoAnswerStep } from "../../lib/noAnswerStreak.js";
import { runClientAutopilotInBackground } from "../../lib/clientAutopilot.js";
import { foreignWriteDenied } from "./shared.js";
import { trashClient } from "../../lib/trashClient.js";
import { fileEndOfWorkDeleteRequest } from "../../lib/clientDeleteRequest.js";
import { securityAutomationOn, securityReviewCloseBlocker } from "../../lib/securityAutomation.js";
import { checkAgentPhoneAsk } from "../../lib/agentPhoneAskDetector.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { closeLeadPushNotifications, sendPushToAgents } from "../../push.js";
import { recordInterest } from "../../lib/propertyInterest.js";
import { findAgentShowingConflict, notifySellerOfShowing, showingTimeLabel } from "../../lib/showingBooking.js";
import { logTimeline } from "../../lib/timeline.js";

export const interactionsRouter = Router();

/** Показ назначен на объект, которого нет или который удалён — откат транзакции, ответ 404. */
class ShowingPropertyNotFoundError extends Error {}

interactionsRouter.post("/:id/interactions", requireAuth, async (req, res) => {
  const parsed = interactionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const ownAgentId = scopeToOwnAgent(req);
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Клиент не найден" });
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

  const data = parsed.data;
  // Дата без текста задачи — задача-невидимка: всё, что показывает и напоминает
  // (календарь, «за час до встречи», вечерняя сводка, KPI дисциплины), отбирает записи
  // по nextAction != null (см. lib/tasks.ts). Форма позволяет назначить показ, задав
  // только дату, — такой показ не появлялся нигде и напоминание по нему не уходило.
  // Добираем текст по типу записи, а не отвергаем запрос: дата важнее формулировки.
  if (data.nextActionDate && !data.nextAction) {
    data.nextAction = data.type === "SHOWING" ? "Показ объекта" : "Связаться с клиентом";
  }
  // «Не ответил» — цепочка перезвонов (переработка 12.08.2026, см.
  // lib/noAnswerStreak.ts). Задача живёт в этой же записи: отдельная запись
  // «перезвонить» засоряла бы хронологию парой строк на каждую неудачную попытку.
  // Серию считаем ДО вставки этой записи — она сама станет последней в серии.
  // Пришло на смену более простому фиксированному перезвону через 15 минут
  // (lib/noAnswerFollowUp.ts, 30.07.2026 — удалён 14.08.2026). Тот же
  // planNoAnswerStep считает серию и для недозвона через CRM-телефонию
  // (lib/telephony/callTracker.ts), так что механизм ровно один, а срок и число
  // попыток берутся из Настроек, а не зашиты числом.
  const noAnswerStep = data.outcome === "NO_ANSWER" ? await planNoAnswerStep(client.id) : null;
  if (noAnswerStep && !noAnswerStep.escalated && !data.nextActionDate) {
    data.nextAction = data.nextAction || noAnswerStep.nextAction!;
    data.nextActionDate = noAnswerStep.nextActionDate!;
  }

  /**
   * ПЕРЕСЕЧЕНИЕ ВРЕМЕНИ С ДРУГИМ ПОКАЗОМ ТОГО ЖЕ АГЕНТА — предупреждение, не блок
   * (пачка 10, 11.09.2026, п.2). Занятость агента при назначении показа намеренно
   * не проверяется (см. lib/showingBooking.ts, решение владельца 31.07.2026) — но
   * ручное назначение из CRM, в отличие от бота, видит живого агента прямо сейчас,
   * и предупредить его дешевле, чем узнать о конфликте на месте.
   */
  const showingConflict =
    data.type === "SHOWING" && data.nextActionDate
      ? await findAgentShowingConflict({ agentId: req.agent!.id, at: data.nextActionDate, excludeClientId: client.id })
      : null;

  // Показ с объектом, которого нет или который в Корзине (ночная проверка,
  // №153): раньше внешний ключ / обновление счётчика роняло всю транзакцию 500.
  // Счётчик просмотров двигаем ПЕРВЫМ шагом, и нулевой счёт — это 404 без записи.
  const interaction = await prisma.$transaction(async (tx) => {
    if (data.type === "SHOWING" && data.propertyId) {
      const bumped = await tx.property.updateMany({
        where: { id: data.propertyId, deletedAt: null },
        data: { viewsCount: { increment: 1 } },
      });
      if (bumped.count === 0) throw new ShowingPropertyNotFoundError();
    }
    const createdRef = await logTimeline({
      ...data,
      clientId: client.id,
      actor: { kind: "agent", agentId: req.agent!.id },
      tx,
    });
    // logTimeline возвращает только { id } — ниже нужен полный ряд
    // (created.createdAt) и роут отдаёт его фронтенду целиком.
    const created = await tx.interaction.findUniqueOrThrow({ where: { id: createdRef.id } });
    /**
     * lastAgentAttemptAt: ИСКЛЮЧЕНИЕ для звонка с заполненным исходом (16.09.2026,
     * инцидент «карусель между 4 агентами» — см. docs/TASKS.md). Раньше ЛЮБАЯ
     * ручная запись не двигала эту метку вовсе (владелец 08.09.2026) — правило
     * верное для заметки в две строки («слова агента о самом себе»), но
     * `type=CALL` с заполненным `outcome` — это НЕ заметка: исход разговора
     * нельзя поставить, не поговорив, это тот же класс доказательства, которому
     * уже доверяет светофор неактивных (см. inactiveTrafficLight.ts,
     * countContactTrace — тот же критерий `callAttempt: null, outcome: not null`).
     * Без этого исключения агент, позвонивший со своего телефона и честно
     * записавший разговор, оставался для тревоги «агент не отвечает» (agentUnansweredAlarm.ts)
     * «ни разу не пытавшимся» — карточку у него забирали, хотя работа шла.
     * Просто заметка (nextAction без исхода звонка) по-прежнему не в счёт.
     *
     * lastContactAt ниже остаётся как был: он отвечает на другой вопрос — «когда
     * карточку вообще трогали» — и его читают отчёты об остывании.
     */
    await tx.client.update({
      where: { id: client.id },
      data: {
        lastContactAt: new Date(),
        // АВТОФИКСАЦИЯ ВРЕМЁН: первая попытка контакта — первая запись
        // Interaction по клиенту, независимо от исхода. Пишется один раз.
        ...(client.firstContactAt ? {} : { firstContactAt: new Date() }),
        ...(data.type === "CALL" && data.outcome != null ? { lastAgentAttemptAt: created.createdAt } : {}),
      },
    });
    return created;
  }).catch((err) => {
    if (err instanceof ShowingPropertyNotFoundError) return null;
    throw err;
  });
  if (!interaction) return res.status(404).json({ error: "Объект не найден" });

  /**
   * Назначенный показ — самый сильный сигнал интереса к объекту (вес 5, см.
   * lib/propertyInterest.ts). Пишется ПОСЛЕ коммита и не ждёт результата:
   * статистика спроса не имеет права задержать сохранение записи агенту.
   */
  if (data.type === "SHOWING" && data.propertyId) {
    void recordInterest(data.propertyId, "SHOWING", client.id);
    // Продавцу — что показывают его объект (пачка 10, 11.09.2026, п.6). Только
    // когда у показа есть время — без него уведомлять «показ назначен» рано.
    if (data.nextActionDate) {
      const atLabel = showingTimeLabel(data.nextActionDate);
      void (async () => {
        const property = await prisma.property.findUnique({
          where: { id: data.propertyId! },
          select: { id: true, title: true, sellerClientId: true },
        });
        if (property) await notifySellerOfShowing(property, atLabel);
      })().catch((err) => console.error("[showing] уведомление продавца (ручной показ):", err instanceof Error ? err.message : err));
    }
  }

  // Предупреждение о пересечении (см. showingConflict выше) — пушем агенту и
  // руководству, не блоком: возможно, агент успеет на оба показа.
  if (showingConflict?.nextActionDate) {
    const conflictNote =
      `Пересечение по времени: показ ${client.fullName} ${showingTimeLabel(data.nextActionDate!)} и ` +
      `показ ${showingConflict.client.fullName} (№${showingConflict.client.shortId}) ` +
      `${showingTimeLabel(showingConflict.nextActionDate)}${showingConflict.property ? ` — ${showingConflict.property.title}` : ""}`;
    void (async () => {
      const supervisors = await findAgentsWithPermission("clients.assign");
      await sendPushToAgents([req.agent!.id, ...supervisors], {
        title: "⏱️ Два показа пересекаются по времени",
        body: conflictNote,
        url: `/clients/${client.shortId}`,
        tag: `showing-conflict-${interaction.id}`,
      });
    })().catch((err) => console.error("[push] пересечение показов:", err instanceof Error ? err.message : err));
  }

  // Детектор «агент спросил номер» в заметке/комментарии к взаимодействию
  // (требование 11 аудита 02.09.2026). Проверяем только текстовые заметки,
  // не системные записи. Фоново — не задерживаем ответ агенту.
  if (data.notes && typeof data.notes === "string" && data.notes.trim().length > 0) {
    void checkAgentPhoneAsk({
      agentId: req.agent!.id,
      agentName: "",
      clientId: client.id,
      clientName: client.fullName ?? null,
      channel: "comment",
      text: data.notes,
    }).catch((err) =>
      console.error("[phone-ask] комментарий:", err instanceof Error ? err.message : err)
    );
  }

  // Автопередача по ИИ-скорингу при исходе NEGATIVE убрана 12.08.2026 (ТЗ владельца):
  // передача — только осознанный выбор агента (см. POST /clients/:id/transfer и
  // ветку TRANSFER в completeMeetingSummary), а не решение модели за него.

  // Попытки дозвониться кончились — руководству (переработка 12.08.2026, см.
  // lib/noAnswerStreak.ts). noAnswerStep уже посчитан выше, до вставки этой записи.
  if (noAnswerStep?.escalated) {
    void notifyNoAnswerEscalation(client, req.agent!.id, noAnswerStep.maxAttempts).catch((err) =>
      console.error("[clients] уведомление о недозвонах:", err instanceof Error ? err.message : err)
    );
  }

  /**
   * «Объект принят в работу» (только продавец) — собственник согласился
   * сотрудничать. CRM сама заводит 36-часовой таймер «Итог объекта»
   * (спецификация, «Путь продавца»/«Контроль объекта»), и заводит его СЕЙЧАС —
   * от исхода звонка, а не от создания карточки Property, которой на этот
   * момент ещё может не быть вовсе (requirePropertySummaries в
   * lib/pendingSummaries.ts отсчитывает от готовой карточки — для объектов,
   * заведённых в обход этого исхода). subjectId — id клиента: как только по
   * заявке создастся карточка объекта, requireSummary переносится на неё без
   * сброса dueAt (см. POST /properties).
   */
  if (data.outcome === "PROPERTY_ACCEPTED" && client.kind === "SELLER") {
    await prisma.client.update({ where: { id: client.id }, data: { propertyAcceptedAt: new Date() } });
    /* Требование «Итог объекта» здесь больше не заводится: механизм обязательных
       окон удалён 13.09.2026. Отметка propertyAcceptedAt остаётся — по ней живёт
       антифрод «продавец без объекта» (lib/sellerPropertyMissingAntifraud.ts), а
       он к окнам отношения не имел. */
  }

  // «Ждёт варианты»/«Ждёт показ» больше не заводят отдельное напоминание-нытьё
  // (kind="waiting_check" убран 12.08.2026): «Ждёт объекты» открывает чат прямо в
  // окне итога, «Ждёт показ» — календарь с собственными напоминаниями за 1д/2ч/40м
  // (см. lib/meetingReminders.ts) — самого итога уже достаточно, отдельный контроль
  // поверх него был лишним.

  // Разговор состоялся — значит про клиента стало известно больше. Карточка
  // дозаполняется, оценка пересчитывается сама (см. lib/clientAutopilot.ts).
  // Раньше и то и другое лежало на кнопках, и обе нажимались примерно никогда.
  runClientAutopilotInBackground(client.id, "interaction_added");

  res.status(201).json({
    ...interaction,
    ...(showingConflict?.nextActionDate
      ? {
          showingConflict: {
            clientId: showingConflict.client.id,
            clientShortId: showingConflict.client.shortId,
            // Имя чужой карточки — тем же правом, что номер (A11, 02.10.2026).
            clientFullName: clientNamePhoneSafe(showingConflict.client.fullName, can(req, "clients.viewPhone")),
            at: showingConflict.nextActionDate,
          },
        }
      : {}),
  });
});

/**
 * Решение службы безопасности по карточке на проверке.
 *
 * С 18.11.2026 (случай ПР-000714: «вопросов нет» закрыло продавца, чей объект
 * продавался) вердикт — прежде всего запись в деле, а не кнопка удаления:
 *  - «Проверено, вопросов нет» карточку НЕ закрывает никогда;
 *  - «Нарушение подтверждено» убирает её в Корзину (восстановимо), только если
 *    автоматика СБ включена и карточка не в работе: нет второй роли, открытой
 *    сделки, объекта в продаже, открытой задачи и работы агента после постановки
 *    на проверку (lib/securityAutomation.ts, securityReviewCloseBlocker).
 * Карточка в работе остаётся как есть (причина — в закрытой записи хронологии);
 * работы нет, но закрывать вердикт не вправе — руководителю заявка на удаление.
 *
 * Решение необратимо только в одну сторону: перепроверить карточку можно, снова
 * отправив её на проверку через обычный отказ. Возвращать «в PENDING» отдельной
 * кнопкой не нужно — это создало бы способ бесконечно откладывать вывод.
 */
interactionsRouter.post(
  "/:id/security-review",
  requireAuth,
  requirePermission("clients.securityReview"),
  async (req, res) => {
    if (!canReadInvestigations(req)) return res.status(403).json({ error: "Недостаточно прав" });
    const parsed = securityReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
    }
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client || client.deletedAt) return res.status(404).json({ error: "Клиент не найден" });
    if (client.securityReview !== "PENDING") {
      return res.status(409).json({ error: "Эта карточка не ждёт проверки" });
    }

    const { verdict, note, noteVoiceUrl, noteVoiceTranscript } = parsed.data;
    const label = SECURITY_REVIEW_LABELS[verdict];

    const reviewed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${client.id} FOR UPDATE`;
      const current = await tx.client.findUnique({ where: { id: client.id } });
      if (!current || current.deletedAt || current.securityReview !== "PENDING") return null;
      // ЧТО ВЕРДИКТ ДЕЛАЕТ С КАРТОЧКОЙ (владелец 18.11.2026, случай ПР-000714: «вопросов
      // нет», а карточку закрыло, хотя объект продавался). «Вопросов нет» не закрывает
      // никогда. «Нарушение подтверждено» закрывает, только если автоматика СБ включена
      // и карточка не в работе (lib/securityAutomation.ts, securityReviewCloseBlocker).
      // Карточка в работе — остаётся как есть, причина в закрытой записи ниже. Работы
      // нет, а в Корзину вердикт её не убирает («вопросов нет» или автоматика
      // выключена) — руководителю заявка на удаление, решает человек (как конец
      // работы после отказа, 16.11.2026): иначе карточка висела бы ничьей.
      const automationOn = await securityAutomationOn(tx);
      const blocker = await securityReviewCloseBlocker(tx, current);
      const outcome: "keep" | "trash" | "delete-request" = blocker ? "keep"
        : verdict === "CONFIRMED" && automationOn ? "trash" : "delete-request";
      // Карточка осталась в работе, а отказ агента уже закрыл его назначение — без
      // возврата она повисла бы ничьей: агент писать в неё не может, новое сообщение
      // клиента её не оживляет (ревью 18.11.2026, случай ПР-000714). Возвращаем агенту.
      const reopen = outcome === "keep" && current.assignmentCompletedAt !== null && current.assignedAgentId !== null;
      await tx.client.update({
        where: { id: client.id },
        data: {
          ...(reopen ? { assignmentRefusedAt: null, assignmentRefusedByAgentId: null, assignmentCompletedAt: null } : {}),
          securityReview: verdict,
          securityReviewedAt: new Date(),
          securityReviewedById: req.agent!.id,
          securityNote: note?.trim() || null,
        },
      });
      await logTimeline({
        clientId: client.id,
        actor: { kind: "agent", agentId: req.agent!.id },
        type: "SYSTEM",
        outcome: verdict === "CONFIRMED" ? "NEGATIVE" : "NEUTRAL",
        investigationOnly: true,
        investigationOrigin: { sourceType: "investigation-decision", sourceId: client.id, independenceKey: `manual:${req.agent!.id}`, kind: "verdict" },
        notes: [`Служба безопасности: ${label}`, note?.trim() ? `Установлено: ${note.trim()}` : null,
          outcome === "keep" ? `Карточка осталась в работе${reopen ? " и возвращена агенту" : ""}: ${blocker}`
            : outcome === "trash" ? "Работы по карточке нет — убирается в Корзину"
            : "Работы по карточке нет — руководителю отправлена заявка на удаление"]
          .filter(Boolean)
          .join(". "),
        // Голосовая заметка к решению (01.09.2026) — переиспользует поля,
        // заведённые для формы «Как прошёл звонок» (см. Interaction.voiceNoteUrl):
        // это та же идея «прикреплённый файл к записи хронологии», отдельной
        // колонки на Client заводить незачем.
        voiceNoteUrl: noteVoiceUrl ?? null,
        voiceNoteTranscript: noteVoiceTranscript ?? null,
        tx,
      });
      await syncLegacyInvestigationVerdict(tx, { clientId: client.id, assignmentAt: current.assignedAt,
        subjectAgentId: current.assignedAgentId, actorId: req.agent!.id, verdict, note: note?.trim() || `Решение руководителя: ${label}` });
      // Карточка закрывается только ПОСЛЕ вердикта — до него она висела как есть
      // нарочно, чтобы не выглядеть решённой.
      return { outcome, blocker, reopen };
    });
    if (!reviewed) return res.status(409).json({ error: "Проверка уже завершена или карточка изменилась — обновите страницу" });

    logAudit(req, "CLIENT_SECURITY_REVIEW", "Client", client.id, { verdict });

    let message = `${label}. Карточка осталась в работе${reviewed.reopen ? " и возвращена агенту" : ""}: ${reviewed.blocker}`;
    if (reviewed.outcome === "trash") {
      const trashed = await trashClient(client.id, req.agent!.id, { notifyHolder: false });
      if (trashed.ok) message = `${label}. Карточка ушла в Корзину`;
      else {
        // Запись вердикта уже сказала «убирается» — правдивый итог второй строкой.
        message = `${label}. Карточка осталась: ${trashed.error}`;
        await logTimeline({ clientId: client.id, actor: { kind: "agent", agentId: req.agent!.id }, type: "SYSTEM",
          investigationOnly: true, notes: `Карточку не удалось убрать в Корзину: ${trashed.error}` }).catch(() => {});
      }
    } else if (reviewed.outcome === "delete-request") {
      await fileEndOfWorkDeleteRequest(client, client.assignedAgentId ?? req.agent!.id,
        "Работа по карточке завершена — решите, удалять ли её.");
      message = `${label}. Работы по карточке нет — руководителю ушла заявка на удаление`;
    }

    // Вердикт вынес один проверяющий — у ОСТАЛЬНЫХ с правом clients.securityReview
    // «⚠️ закрытие требует проверки» по этой карточке без этого висело бы вечно
    // (найдено 07.09.2026, тот же класс, что и lead-escalated-*: рассылка всем,
    // закрытия не было ни у кого). Сам вердикт украсть нельзя — выше 409-гейт
    // по securityReview!=="PENDING" — это чистка мусорного уведомления, не гонка.
    void (async () => {
      const reviewers = await findAgentsWithPermission("clients.securityReview");
      await closeLeadPushNotifications(reviewers.map((id) => ({ agentId: id, tag: `security-review-${client.id}` })));
    })().catch((err) => console.error("[push] закрытие проверки СБ у остальных проверяющих:", err));

    res.json({ ok: true, verdict, message });
  }
);

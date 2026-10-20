import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { logTimeline } from "../lib/timeline.js";
import { dushanbeInputToDate, dushanbeStartOfToday } from "../lib/dushanbeTime.js";
import { findClientDeliveryTarget, deliverToConversation } from "../lib/conversationDelivery.js";
import { resolveReactivationTaskAgentId, fillReactivationTemplate } from "../lib/reactivationCampaign.js";
import type { JobHandler } from "./registry.js";

/**
 * ОТПРАВКА ОДНОМУ КЛИЕНТУ (Пачка 12, 11.09.2026) — поставлено
 * lib/reactivationCampaign.ts::runReactivationCampaignTick, по одному заданию
 * на клиента (см. doc-comment там же про причину не слать всей пачкой в одном
 * тике).
 *
 * ПОВТОРНАЯ ПРОВЕРКА АКТУАЛЬНОСТИ. Между постановкой (понедельник 10:00) и
 * исполнением (очередь может отставать) карточка могла измениться — клиент сам
 * написал, агент взял его в работу, карточка ушла в Корзину. run() перечитывает
 * клиента и тихо завершается (без throw — это не отказ, это «уже не актуально»),
 * если условия отбора больше не выполняются.
 *
 * ПОВТОР НЕ ШЛЁТ ВТОРОЕ СООБЩЕНИЕ (№168 ночной проверки 24.09). Медленный Meta
 * (до ~67 с собственных повторов) был дольше общей минуты раннера: попытку
 * снимали с ожидания, задание уходило в повтор, а первая попытка всё равно
 * досылала — клиент получал одно и то же дважды, у агента две задачи
 * «Перезвонить». Теперь две защиты:
 *  - срок попытки 3 минуты (`timeoutMs`), а повтор после таймаута раннер ставит
 *    не раньше этого срока (jobs/runner.ts) — к нему первая попытка уже либо
 *    дослала и записала строку ниже, либо упала;
 *  - перед отправкой ищется строка `[reactivation]` у этого клиента с начала
 *    дня недели задания (`weekKey`): есть — сообщение этой недели уже ушло,
 *    выходим. Замок пишется ПОСЛЕ доставки, а не до: отметка «до» при
 *    упавшей доставке (503) заперла бы клиенту неделю без сообщения.
 * Остаётся только падение процесса между доставкой и записью — окно в
 * миллисекунды, без отдельной таблицы «уже отправлено» его не закрыть.
 * Сбой самой записи (моргнула база) повтора не вызывает — см. ниже (02.10.2026).
 */
const schema = z.object({
  clientId: z.string(),
  weekKey: z.string(),
});

const REACTIVATION_ELIGIBLE_STATUSES = new Set(["COLD", "LOST"]);

export const clientReactivationJob: JobHandler<z.infer<typeof schema>> = {
  type: "client-reactivation",
  schema,
  // Один сетевой вызов к мессенджеру — короткая лесенка достаточно: 1м → 2м → 4м → 8м → 16м.
  backoff: (attempt) => Math.min(2 ** attempt, 16) * 60_000,
  // Срок попытки — с запасом над медленным Meta (до ~67 с своих повторов,
  // messengers/meta.ts), см. шапку файла (№168).
  timeoutMs: 3 * 60_000,
  async run(payload) {
    const client = await prisma.client.findUnique({
      where: { id: payload.clientId },
      select: {
        id: true,
        shortId: true,
        fullName: true,
        deletedAt: true,
        status: true,
        workStatus: true,
        assignedAgentId: true,
        lastAgentId: true,
        reactivationOfferedToAgentId: true,
      },
    });
    if (!client || client.deletedAt) return; // ушёл в Корзину между постановкой и исполнением
    if (client.reactivationOfferedToAgentId) return; // подхвачен своей реактивацией к прежнему агенту
    const stillEligible = REACTIVATION_ELIGIBLE_STATUSES.has(client.status) || client.workStatus === "INACTIVE";
    if (!stillEligible) return; // агент или клиент сами сдвинули карточку с места — сообщение больше не нужно

    // Сообщение этой недели уже ушло (прошлая попытка того же задания дослала
    // после таймаута) — второе не шлём, вторую задачу не заводим. См. шапку.
    const weekStart = dushanbeInputToDate(payload.weekKey, "00:00");
    if (!Number.isNaN(weekStart.getTime())) {
      const alreadySent = await prisma.interaction.findFirst({
        where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "[reactivation]" }, createdAt: { gte: weekStart } },
        select: { id: true },
      });
      if (alreadySent) return;
    }

    const target = await findClientDeliveryTarget(client.id);
    if (!target) return; // нет диалога, отправлять некуда

    if (target.kind === "bot") {
      const conversation = await prisma.botConversation.findUnique({ where: { id: target.id }, select: { optedOutAt: true } });
      if (conversation?.optedOutAt) return; // «не пишите мне» — тик уже фильтрует, но диалог мог измениться позже отбора
    }

    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { reactivationMessageTemplate: true },
    });

    const taskAgentId = await resolveReactivationTaskAgentId(client);
    if (!taskAgentId) {
      await logSystemError(
        "background-jobs",
        `Реактивация клиента ${payload.clientId}: не нашлось ни владельца, ни прежнего агента, ни действующего директора для задачи «перезвонить»`,
        { url: `/clients/${client.shortId}` }
      );
      return;
    }
    const agent = await prisma.agent.findUnique({ where: { id: taskAgentId }, select: { fullName: true } });

    const text = fillReactivationTemplate(
      settings?.reactivationMessageTemplate ?? "Здравствуйте, {name}! Это Royal Home. Ваш вопрос с недвижимостью всё ещё актуален?",
      client.fullName,
      agent?.fullName ?? "наш менеджер"
    );

    const delivery = await deliverToConversation(target, text);
    if (!delivery.ok) {
      if (delivery.code === "window_closed") return; // окно мессенджера закрыто — не программная ошибка, повторять тем же текстом бессмысленно
      // Канал временно недоступен (503) — тот самый внешний вызов, который
      // обязан ретраиться, а не тихо считаться выполненным.
      throw new Error(`Реактивация клиента ${payload.clientId} не отправлена: ${delivery.error}`);
    }

    // «Перезвонить» на завтра (владелец, Пачка 12 п.2) — полдень по Душанбе,
    // тот же приём, что у dushanbeInputToDate по умолчанию: заметнее посреди
    // рабочего дня, чем в полночь.
    const tomorrowNoon = new Date(dushanbeStartOfToday(new Date()).getTime() + 24 * 3600_000 + 12 * 3600_000);

    // SYSTEM — сообщение отправила автоматика, не taskAgentId (который может
    // быть и директором-фолбэком из resolveReactivationTaskAgentId, — П-10,
    // 17.09.2026); subjectAgentId держит задачу «перезвонить» в его делах.
    /**
     * СБОЙ ЗАПИСИ ПОСЛЕ ДОСТАВКИ — НЕ ПОВОД ПОВТОРЯТЬ ЗАДАНИЕ (Ф10 аудита фона
     * 02.10.2026). Сообщение уже у клиента; исключение отсюда уводило задание в
     * повтор, а замок недели (выше) ищет как раз эту строку — её нет, и клиент
     * получал то же сообщение второй раз. Лучше потерять строку в хронологии
     * (о ней — запись в журнал), чем написать человеку дважды.
     */
    try {
      await logTimeline({
        clientId: client.id,
        actor: { kind: "system", source: "reactivation", subjectAgentId: taskAgentId },
        type: "SYSTEM",
        // Префикс восстановлен явно (auto-add убран из lib/timeline.ts, 17.09.2026,
        // регресс на своём же коде) — lib/morningNumbers.ts ищет ровно этот тег.
        notes: "[reactivation] Реактивация: сообщение отправлено",
        nextAction: `Перезвонить — реактивация, клиент ${client.fullName}`,
        nextActionDate: tomorrowNoon,
      });
    } catch (err) {
      await logSystemError(
        "background-jobs",
        `Реактивация: сообщение клиенту ушло, но строка в хронологии и задача «перезвонить» не записаны — ${describeError(err)}`,
        { url: `/clients/${client.shortId}`, dedupKey: "Реактивация: сообщение ушло, строка в хронологии не записана" }
      );
    }
  },
  async onGiveUp(payload) {
    // url не задаём — payload несёт только Client.id (uuid), а ссылка в CRM
    // строится по shortId; отдельный запрос за ним ради строки лога того не стоит.
    await logSystemError(
      "background-jobs",
      `Реактивационное сообщение клиенту ${payload.clientId} (неделя ${payload.weekKey}) не отправлено после всех попыток`
    );
  },
};

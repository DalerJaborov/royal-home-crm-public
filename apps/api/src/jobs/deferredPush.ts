import { z } from "zod";
import { logSystemError } from "../lib/systemError.js";
import { deliverPushToAgents } from "../push.js";
import type { JobHandler } from "./registry.js";

/**
 * ПУШ, ОТЛОЖЕННЫЙ ДО НАЧАЛА РАБОЧЕГО ДНЯ (владелец 12.09.2026: «ночью запрещено
 * слать пуши всем пользователям, только в начале рабочего дня»).
 *
 * Ставится самим транспортом (apps/api/src/push.ts) с `runAt` = ближайшие 08:00
 * по Душанбе, когда lib/pushQuietHours.ts решил «defer». Отдельной таблицы под
 * это не заводилось: у BackgroundJob уже есть `runAt`, блокировка воркером и
 * учёт попыток — новая таблица дублировала бы всё это ради одного поля.
 *
 * ЛЕНТУ УВЕДОМЛЕНИЙ ЭТОТ ОБРАБОТЧИК НЕ ПИШЕТ. Запись создана ещё ночью, в момент
 * события: тишина касается только звонка устройства. Поэтому здесь вызывается
 * `deliverPushToAgents` — доставка без записи в ленту и без повторной проверки
 * тихих часов (иначе задание, подхваченное воркером с опозданием, откладывало бы
 * само себя по кругу).
 *
 * ИДЕМПОТЕНТНОСТЬ: повторный прогон отправит тот же пуш с тем же `tag` — на
 * устройстве он заменит уже показанную карточку, а не ляжет второй.
 */
const schema = z.object({
  agentIds: z.array(z.string()).min(1).max(200),
  payload: z.object({
    title: z.string(),
    body: z.string(),
    kind: z.string().optional(),
    level: z.string().optional(),
    url: z.string().optional(),
    tag: z.string().optional(),
    avatarUrl: z.string().optional(),
    actionToken: z.string().optional(),
    actions: z
      .array(z.object({ action: z.string(), title: z.string() }))
      .max(4)
      .optional(),
  }),
});

export const deferredPushJob: JobHandler<z.infer<typeof schema>> = {
  type: "deferred-push",
  schema,
  // Отказ доставки утром — это либо упавший push-сервис, либо сеть. Лесенка
  // короткая: смысл «в начале рабочего дня» теряется к обеду.
  backoff: (attempt) => Math.min(2 ** attempt, 8) * 60_000,
  async run(payload) {
    await deliverPushToAgents(payload.agentIds, payload.payload as Parameters<typeof deliverPushToAgents>[1]);
  },
  async onGiveUp(payload) {
    await logSystemError(
      "background-jobs",
      `Отложенное на утро уведомление «${payload.payload.title}» не ушло после всех попыток — запись осталась только в ленте`, { dedupKey: "Отложенное на утро уведомление «…» не ушло после всех попыток — запись осталась только в ленте" }
    );
  },
};

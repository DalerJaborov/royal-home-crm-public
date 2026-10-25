import { filterInvestigationRecipients } from "./investigationNotifications.js";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { notificationLevelOf, type NotificationLevel } from "@royal-home/shared";
import { logSystemError } from "./systemError.js";
import { publishNotificationNew } from "./livePublish.js";
import { maskPhonesInText } from "./clientPhone.js";
import { partitionByPermission } from "./recipients.js";

/**
 * Обёртка над записью в ленту уведомлений (модель Notification, добавлена
 * 17-18.08.2026 под экран «notif» из design_handoff — see docs/mobile-design-system.md).
 *
 * Вызывается РЯДОМ с уже существующими sendPushToAgent/sendPushToAgents, тем же
 * title/body/url — одна точка правды на текст, лента и push не расходятся.
 * Push эфемерен (не долетел — устройство офлайн, нет подписки, юзер выключил в
 * браузере); эта запись остаётся постоянно и не зависит от VAPID/подписки.
 *
 * Ошибка записи не должна ронять вызывающий код (push уже ушёл или уходит
 * своим путём) — поэтому не пробрасываем исключение, а логируем через
 * logSystemError, как остальные внешние/побочные вызовы в проекте.
 */
/**
 * ТЕЛЕФОН КЛИЕНТА В СТРОКЕ ЛЕНТЫ — ТА ЖЕ УТЕЧКА, ЧТО И ПОЛЕ `phone`
 * (22.09.2026, ночной обход по классу «номер уходит мимо прав»).
 *
 * Лента уведомлений оказалась единственным каналом, куда правило
 * `clients.viewPhone` (lib/clientPhone.ts) не заглядывало ни разу, — и худшим
 * из возможных: тело собирается из `Client.fullName` и `Client.phone` в трёх
 * десятках мест (напоминание о показе, заявка на обратный звонок, голосовое
 * сообщение, первый звонок, передача лида), пишется в БД и живёт в
 * колокольчике постоянно. То есть номер не мелькал на экране, а оседал —
 * и «открой уведомления» становилось обходом запрета.
 *
 * ПОЧЕМУ ЗДЕСЬ. Это единственная точка, через которую строка попадает в ленту:
 * и `sendPushToAgent(s)`, и прямые вызывающие (алармы, дайджесты, очередь
 * уведомлений директору) приходят сюда. Тот же довод, что в шапках
 * lib/ownerContact.ts и lib/clientPhone.ts: правило, записанное в одном
 * вызывающем, правилом не является.
 *
 * ПО ПОЛУЧАТЕЛЮ: строка своя у каждого сотрудника, поэтому директор и
 * администратор (право `clients.viewPhone`) видят номер и могут позвонить
 * прямо из уведомления, а остальные получают маску.
 *
 * УЗКИЙ РАЗБОР, А НЕ maskPhonesInFreeText: тело уведомления — собранная нами
 * строка, где рядом стоят дата и время («Показ 22.09.2026 14:30» — десять цифр
 * с разделителями), и добивка по цепочке превратила бы её в «2209•••••14:30».
 * Свободный текст внутри уведомления (расшифровка голосового, тема заявки,
 * написанная моделью) закрывает вызывающий через phoneSafeText — см.
 * lib/callbackRequests.ts и lib/telephony/voicemailIngest.ts.
 */
async function splitByPhoneRight<T extends { title: string; body: string }>(
  agentIds: string[],
  payload: T
): Promise<{ agentIds: string[]; payload: T }[]> {
  // Подавляющее большинство уведомлений номера не содержит вовсе («Объект
  // одобрен», «Задача просрочена»), и делить получателей там не по чему.
  // Маска — чистая работа со строкой, поэтому дешевле применить её и сравнить,
  // чем ходить в базу за правами: запрос остаётся только там, где он что-то
  // решает. Это важно не только ради скорости — createNotification зовут из
  // горячих путей, часто без await, и лишний поход в базу перед вставкой
  // растягивает окно, в котором строки ещё нет.
  const title = maskPhonesInText(payload.title);
  const body = maskPhonesInText(payload.body);
  if (title === payload.title && body === payload.body) return [{ agentIds, payload }];

  const { granted, denied } = await partitionByPermission(agentIds, "clients.viewPhone");
  const groups: { agentIds: string[]; payload: T }[] = [];
  if (granted.length > 0) groups.push({ agentIds: granted, payload });
  if (denied.length > 0) {
    groups.push({
      agentIds: denied,
      payload: { ...payload, title, body },
    });
  }
  return groups;
}

export async function createNotification(input: {
  agentId: string;
  kind: string;
  title: string;
  body: string;
  url?: string | null;
  /** Тот же tag, что уходит в push (владелец 20.08.2026) — повторное событие
   *  с этим же tag обновляет уже существующую строку вместо новой. */
  tag?: string | null;
  /** Важность (владелец 09.09.2026). Не задана — выводится из kind, см.
   *  notificationLevelOf: указывать её нужно только там, где умолчание врёт. */
  level?: NotificationLevel;
}): Promise<void> {
  try {
    if (!(await filterInvestigationRecipients([input.agentId], input)).length) return;
    // Группа ровно одна — получатель один; пустой она не бывает.
    const [group] = await splitByPhoneRight([input.agentId], input);
    await upsertByTag(group ? { ...input, title: group.payload.title, body: group.payload.body } : input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[notifications] Не удалось записать уведомление:", message);
    void logSystemError("api", `Не удалось записать уведомление в ленту: ${message}`);
  }
}

/**
 * УВЕДОМЛЕНИЕ БЕЗ ЗВОНКА ТЕЛЕФОНА (владелец 20.09.2026).
 *
 * Дословно: «эскалация убрать, то есть прямо таки пуш не нужно, это всё равно
 * отдельно видит руководитель на своём дашборде». Речь не о том, чтобы стереть
 * информацию, — руководитель должен и дальше находить случай в колокольчике и в
 * своих списках, — а о том, чтобы по второму шагу одной и той же истории («агент
 * не сделал X вовремя») ни у кого не вибрировал телефон.
 *
 * Поэтому эскалации переведены с sendPushToAgents на эту функцию: строка в ленте
 * пишется ровно так же и открытый экран обновляется так же, а web-push не
 * отправляется вовсе. Сюда же смотреть, если завтра понадобится добавить новое
 * «руководству к сведению»: у такого уведомления нет адресата, который должен
 * бросить дела сию секунду, — значит и пуша у него быть не должно.
 *
 * Не путать с тихими часами (lib/pushQuietHours.ts): там пуш откладывается до
 * утра, здесь его нет по существу, в любое время суток.
 */
export async function notifyFeedOnly(
  agentIds: string[],
  payload: {
    kind: string;
    title: string;
    body: string;
    url?: string | null;
    tag?: string | null;
    level?: NotificationLevel;
  }
): Promise<void> {
  agentIds = await filterInvestigationRecipients(agentIds, payload);
  if (agentIds.length === 0) return;
  await createNotifications(agentIds, payload);
  publishNotificationNew(agentIds);
}

/** То же самое сразу нескольким агентам — без N отдельных запросов к БД. */
export async function createNotifications(
  agentIds: string[],
  payload: {
    kind: string;
    title: string;
    body: string;
    url?: string | null;
    tag?: string | null;
    level?: NotificationLevel;
  }
): Promise<void> {
  agentIds = await filterInvestigationRecipients(agentIds, payload);
  if (agentIds.length === 0) return;
  try {
    // Телефон клиента — по праву получателя (см. splitByPhoneRight выше): текст
    // один на всех, а строка в ленте у каждого своя.
    for (const group of await splitByPhoneRight(agentIds, payload)) {
      await writeNotifications(group.agentIds, group.payload);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[notifications] Не удалось записать уведомления:", message);
    void logSystemError("api", `Не удалось записать уведомления в ленту: ${message}`);
  }
}

/** Запись как есть, без разбора прав, — то, чем createNotifications была до
 *  разделения получателей по праву на телефон. */
async function writeNotifications(
  agentIds: string[],
  payload: {
    kind: string;
    title: string;
    body: string;
    url?: string | null;
    tag?: string | null;
    level?: NotificationLevel;
  }
): Promise<void> {
  {
    if (payload.tag) {
      // С tag — у каждого получателя своя история этого повода (например,
      // "невозвращённый ключ" видели разные руководители в разное время),
      // поэтому объединяем по одному, а не одним createMany. Получателей
      // здесь единицы (руководство, дежурные) — не тот N+1, от которого
      // предостерегает CLAUDE.md для списков клиентов/объектов.
      for (const agentId of agentIds) {
        await upsertByTag({ agentId, ...payload });
      }
      return;
    }
    const level = notificationLevelOf(payload.kind, payload.level);
    await prisma.notification.createMany({
      data: agentIds.map((agentId) => ({
        agentId,
        kind: payload.kind,
        level,
        title: payload.title,
        body: payload.body,
        url: payload.url ?? null,
      })),
    });
  }
}

/**
 * ГАСИТ СТРОКИ В ЛЕНТЕ УВЕДОМЛЕНИЙ (колокольчик) У АГЕНТА, ЧЕЙ КЛИЕНТ УШЁЛ
 * ДРУГОМУ (11.09.2026, второй заход по осиротевшим спутникам).
 *
 * closeLeadPushNotification гасит только OS-баннер устройства — саму СТРОКУ в
 * ленте (Notification.read) до этой функции не трогал никто, кроме общего
 * 90-дневного TTL в cron.ts. Факт с прода 11.09: из 97 непрочитанных «лид» 78
 * висели у агентов, у которых клиента уже нет.
 *
 * Помечает read=true все непрочитанные строки этого агента, которые ведут к
 * данному клиенту: по тому же `tag`, что использует push (`lead-{clientId}`),
 * и по `url`, начинающемуся с `/clients/{shortId}` — вторая проверка ловит
 * уведомления без tag (просьба о звонке, задача, антифрод-алярм по карточке),
 * которые тоже стали чужими. Не удаляет строки — агент должен видеть в
 * истории, что событие было, просто оно больше не требует его внимания.
 *
 * СТАВИТ retiredAt/retiredReason (Пачка 19, 12.09.2026), а не только
 * read=true — до этого фронт красил «Передан» эвристикой (kind==="lead" &&
 * read && url на карточку, apps/web/src/lib/notificationTransferHint.ts),
 * которая путала честно прочитанный лид с погашенным системой. Теперь read=true
 * и retiredAt ставятся ОДНИМ вызовом, и только отсюда — «прочитал сам» и
 * «погасили за него» больше не выглядят одинаково.
 *
 * $executeRaw, а не `prisma.notification.updateMany` с новыми полями в data:
 * retiredAt/retiredReason добавлены миграцией
 * `20260912100000_notification_retired_flag`, но `prisma generate` в этом
 * заходе сознательно не запускался (см. agent-brief Пачка 19) — сгенерированный
 * клиент их ещё не знает, а TS отказался бы принимать лишние ключи в `data`.
 * Сборщик перегенерирует клиент перед мержем — раскладка сохранится, эта
 * функция как единственная точка записи retiredAt продолжит работать так же.
 *
 * Best-effort: ошибка не должна ронять вызывающую передачу владения.
 */
export async function closeNotifications(
  agentId: string,
  target: { clientId: string; clientShortId?: number | null },
  reason: string
): Promise<void> {
  try {
    const tag = `lead-${target.clientId}`;
    // "/clients/104" не должен зацепить "/clients/1042" — сверяем точное
    // совпадение и оба варианта продолжения (query-строка, подпуть).
    const urlPrefix = typeof target.clientShortId === "number" ? `/clients/${target.clientShortId}` : null;
    // Причина обрезается: это подпись на строке уведомления, а не полный текст
    // Interaction — длинные тексты (freeze несёт голос агента дословно) не
    // должны раздувать список.
    const retiredReason = reason.trim().slice(0, 300) || null;
    await prisma.$executeRaw`
      UPDATE "Notification"
      SET "read" = true, "retiredAt" = NOW(), "retiredReason" = ${retiredReason}
      WHERE "agentId" = ${agentId}
        AND "read" = false
        AND (
          "tag" = ${tag}
          ${
            urlPrefix
              ? Prisma.sql`OR "url" = ${urlPrefix} OR "url" LIKE ${`${urlPrefix}?%`} OR "url" LIKE ${`${urlPrefix}/%`}`
              : Prisma.empty
          }
        )
    `;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[notifications] Не удалось закрыть уведомления клиента:", message);
    void logSystemError("api", `Не удалось закрыть уведомления клиента ${target.clientId} у агента ${agentId}: ${message}`);
  }
}

/**
 * ОБЩИЙ ПРЕДОХРАНИТЕЛЬ ПО ЧАСТОТЕ (владелец 15.09.2026, разбор прода: одна и та же
 * строка «Объект просрочен на проверке» доходила до счётчика 128, «Нет звонка 2+ дн» —
 * до 10, потому что часовой крон-тик ставил аларм в очередь/ленту БЕЗУСЛОВНО на
 * каждый свой проход, пока причина не устранена. upsertByTag (выше) схлопывает уже
 * СОЗДАННЫЕ строки в одну и растит count, но не мешает создавать их заново — счётчик
 * считает тики, а не сам факт просрочки.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА: повторное напоминание об одном и том же поводе — не чаще
 * `minIntervalMs` (сейчас везде раз в сутки). Проверяем ОБА места, откуда повод мог
 * взяться: PendingDirectorAlert (очередь, propertyPipeline.ts кладёт туда даже вне
 * часов алармов) и Notification (ленту, куда buyerNoCallAlarm.ts/sellerNoPropertyAlarm.ts
 * пишут напрямую, без очереди) — и берём более свежую из двух отметок.
 *
 * Идиома — та же, что уже в reactivationOffers.ts:289-290 (`findFirst` по tag,
 * `if (already) continue`), только с окном по времени вместо разового «уже было».
 * Логику обнаружения проблемы это не меняет — меняется только частота напоминания:
 * повод пропал и появился снова — сигнал пройдёт как обычно, как только окно истечёт.
 */
export async function shouldAlert(
  tag: string,
  minIntervalMs: number,
  now: Date = new Date()
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - minIntervalMs);
  const [lastQueued, lastNotified] = await Promise.all([
    prisma.pendingDirectorAlert.findFirst({
      where: { tag },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.notification.findFirst({
      where: { tag },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const lastAt =
    lastQueued && lastNotified
      ? (lastQueued.createdAt > lastNotified.createdAt ? lastQueued.createdAt : lastNotified.createdAt)
      : (lastQueued?.createdAt ?? lastNotified?.createdAt ?? null);
  return !lastAt || lastAt < cutoff;
}

/**
 * Одна запись с учётом tag: то же самое событие (тот же agentId+tag) обновляет
 * существующую строку — count растёт, свежий текст и время встают поверх, а
 * read сбрасывается (новое повторение — снова непрочитанное, даже если старое
 * уже открывали). Без tag — как раньше, всегда новая строка.
 *
 * Поиск-потом-запись, а не атомарный upsert: у Notification нет уникального
 * индекса на (agentId, tag) — большинство вызовов tag не передают вовсе, и
 * уникальность по (agentId, null) для них была бы неверной. Гонка при двух
 * почти одновременных повторах одного и того же события возможна теоретически
 * (появятся две строки вместо одной), но безобидна и самолечится следующим
 * повтором — тот же порядок цены, что и у похожих неатомарных мест в проекте.
 */
async function upsertByTag(input: {
  agentId: string;
  kind: string;
  title: string;
  body: string;
  url?: string | null;
  tag?: string | null;
  level?: NotificationLevel;
}): Promise<void> {
  const level = notificationLevelOf(input.kind, input.level);
  if (input.tag) {
    const existing = await prisma.notification.findFirst({
      where: { agentId: input.agentId, tag: input.tag },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      try {
        await prisma.notification.update({
          where: { id: existing.id },
          data: {
            title: input.title,
            body: input.body,
            url: input.url ?? null,
            // Уровень тоже обновляется: тот же повод мог стать срочнее, чем был
            // (первое напоминание о просрочке и четвёртое — не одно и то же).
            level,
            count: { increment: 1 },
            read: false,
            createdAt: new Date(),
          },
        });
        return;
      } catch (err) {
        /**
         * Строку удалили МЕЖДУ поиском и записью — агент прочитал ленту и смахнул
         * уведомление ровно в эту миллисекунду, либо уборка забрала старое. Раньше
         * это выбрасывало P2025 наверх, вызывающий код ловил его общим catch, и
         * уведомление ТЕРЯЛОСЬ целиком: событие произошло, а в ленте пусто.
         * Правильный ответ на исчезнувшую строку — завести новую, а не молча
         * потерять повод. Любую другую ошибку пробрасываем как прежде.
         */
        const code = (err as { code?: string })?.code;
        if (code !== "P2025") throw err;
      }
    }
  }
  await prisma.notification.create({
    data: {
      agentId: input.agentId,
      kind: input.kind,
      level,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
      tag: input.tag ?? null,
    },
  });
}

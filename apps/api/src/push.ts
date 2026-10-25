import { filterInvestigationRecipients } from "./lib/investigationNotifications.js";
import webpush from "web-push";
import type { Prisma } from "./generated/prisma/client.js";
import type { PushPayload } from "@royal-home/shared";
import { prisma } from "./db.js";
import { logSystemError } from "./lib/systemError.js";
import { createNotification, createNotifications } from "./lib/notifications.js";
import type { SystemErrorSource } from "./lib/systemError.js";
import { quietDecision, quietHoursEndAfter } from "./lib/pushQuietHours.js";
import { enqueueBackgroundJob } from "./jobs/enqueue.js";
import { publishNotificationNew } from "./lib/livePublish.js";
import { maskPhonesInText } from "./lib/clientPhone.js";
import { partitionByPermission } from "./lib/recipients.js";

const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@royalhome.tj";

const configured = Boolean(publicKey && privateKey);
if (configured) {
  webpush.setVapidDetails(subject, publicKey!, privateKey!);
} else {
  console.warn("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY не заданы — push-уведомления отключены (см. .env.example)");
}

export function isPushConfigured() {
  return configured;
}

export function getVapidPublicKey() {
  return publicKey ?? null;
}

/** Описание payload переехало в @royal-home/shared: его вторая копия лежала в
 *  service worker и синхронизировалась руками. Реэкспорт — чтобы не переписывать
 *  два десятка импортов по всему API. */
export type { PushPayload } from "@royal-home/shared";

export type PushSubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * Личные настройки: сотрудник выключил себе этот вид уведомлений.
 *
 * Отбор идёт на сервере, до отправки, и вместе с подписками ОДНИМ запросом —
 * отдельный поход в Agent на каждый push означал бы удвоение запросов на
 * рассылках руководству.
 *
 * Уведомление без `kind` не отбирается никогда: служебные сигналы (невозвращённый
 * ключ, сбой интеграции, эскалация) не должны молча выключаться заодно с чем-то,
 * что человек отключал совсем про другое.
 */
function isMuted(payload: PushPayload, muted: string[] | undefined): boolean {
  return Boolean(payload.kind && muted?.includes(payload.kind));
}

/** Payload без служебных полей: `kind` нужен только серверу и на устройство не едет. */
function wirePayload(payload: PushPayload): Omit<PushPayload, "kind"> {
  const { kind: _kind, ...rest } = payload;
  return rest;
}

/**
 * Web Push (и Apple, и FCM) режет тело на ~4096 байт: сверх лимита — 413 у
 * web.push.apple.com и 400 «binary data must be less than 4096 bytes» у FCM,
 * уведомление молча не доезжает. Прод-случай 25.08.2026: запасной аватар клиента
 * ехал в avatarUrl как data:-URI на 4-13 КБ. Источник тогда починили (аватар теперь
 * короткий путь /uploads/...), но сам транспорт оставался без защиты — любой из
 * ~60 вызовов sendPushToAgent(s) с длинным body или клиент с legacy data:-URI в
 * базе ронял бы доставку снова. Потолок ниже лимита с запасом на шифрование.
 */
const PUSH_BODY_MAX_BYTES = 3800;

export function fitWireBody(wire: Omit<PushPayload, "kind">): string {
  // data:-URI в аватаре не лечится усечением — выбрасываем сразу (закрывает и
  // legacy-значения в базе, и будущие небрежные вызовы): иконка — украшение,
  // недоставленное уведомление — потеря.
  if (wire.avatarUrl?.startsWith("data:")) delete wire.avatarUrl;
  let body = JSON.stringify(wire);
  if (Buffer.byteLength(body) <= PUSH_BODY_MAX_BYTES) return body;
  delete wire.avatarUrl;
  // Текст уведомления режем с запасом: JSON-экранирование кириллицы и служебные
  // поля не дают посчитать точно, а шторка всё равно показывает пару строк.
  if (wire.body) wire.body = wire.body.slice(0, 500);
  body = JSON.stringify(wire);
  while (Buffer.byteLength(body) > PUSH_BODY_MAX_BYTES && wire.body && wire.body.length > 0) {
    wire.body = wire.body.slice(0, Math.floor(wire.body.length / 2));
    body = JSON.stringify(wire);
  }
  return body;
}

/**
 * Пуш о ЖИВОМ звонке позже этого срока уже бесполезен — короткий разговор
 * успеет кончиться раньше, чем уведомление доедет. Ограничивает одну отправку
 * дважды: опцией транспорта (сокет-таймаут HTTPS-запроса) и внешней гонкой —
 * опция покрывает зависший сокет, гонка страхует любое другое зависание
 * транспорта. Раньше webpush.sendNotification был единственным внешним вызовом
 * в цепочке входящего звонка без таймаута вовсе (правило CLAUDE.md «каждый
 * внешний вызов — с явным таймаутом»): зависший FCM/APNs подвешивал
 * finishIncomingCall целиком — итог звонка, задача перезвонить и запись
 * разговора не фиксировались, пока не истечёт таймаут самого FCM.
 */
const PUSH_SEND_TIMEOUT_MS = 10_000;

async function sendWithTimeout(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      webpush.sendNotification(subscription, body, { timeout: PUSH_SEND_TIMEOUT_MS }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("push-таймаут: транспорт не ответил вовремя")), PUSH_SEND_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Хост эндпоинта пуш-сервиса (fcm.googleapis.com / web.push.apple.com) — для
 * журнала ошибок. Не весь endpoint: в нём лежит идентифицирующий устройство
 * токен подписки, хосту достаточно, чтобы понять, какой сервис отказал.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
}

/**
 * Рассылает уже загруженным подпискам. Ошибки одной подписки не должны ронять
 * остальные — каждая обрабатывается независимо, а протухшие (410/404 — пользователь
 * отключил уведомления в браузере) тихо удаляются.
 *
 * Возвращает число устройств, до которых уведомление реально доехало. Нужно там,
 * где по факту отправки ставится отметка «предупреждали»: без ключей VAPID или без
 * единой подписки функция молча выходила, а вызывающий считал, что всё отправлено.
 */
async function deliverToSubscriptions(subs: PushSubscriptionRow[], payload: PushPayload): Promise<number> {
  if (subs.length === 0) return 0;
  return deliverBodyToSubscriptions(subs, fitWireBody(wirePayload(payload)));
}

/**
 * КОД ВХОДА ПУШЕМ (19.10.2026). Прямая доставка готового тела на заданные подписки:
 * мимо ленты уведомлений (код не должен оседать в истории), мимо тихих часов
 * (человек входит сам, прямо сейчас) и мимо личных отключений видов. В отличие от
 * обычных пушей поле `kind` едет на устройство как есть: по нему сервис-воркер
 * узнаёт код входа и подтверждает доставку (POST /auth/login/code-ack).
 * Возвращает число подписок, принявших уведомление.
 */
export async function sendLoginCodePush(subs: PushSubscriptionRow[], wire: Record<string, unknown>): Promise<number> {
  if (!configured || subs.length === 0) return 0;
  return deliverBodyToSubscriptions(subs, JSON.stringify(wire));
}

async function deliverBodyToSubscriptions(subs: PushSubscriptionRow[], body: string): Promise<number> {

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        await sendWithTimeout({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
        return 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          // Код и тело ответа — то немногое, что реально различает причины отказа
          // (403 — расхождение VAPID-ключа, подписка мертва навсегда; 429 — сервис
          // ограничил частоту, подписка рабочая; 5xx — временный сбой у FCM/Apple).
          // Раньше здесь лежал голый err.message — одна и та же строка "Received
          // unexpected response code" на все три случая, и по журналу было
          // невозможно понять, какую подписку вообще стоит чистить.
          const message = err instanceof Error ? err.message : String(err);
          const respBody = (err as { body?: string }).body;
          const detail = [
            statusCode ? `код ${statusCode}` : null,
            endpointHost(sub.endpoint),
            respBody ? respBody.slice(0, 200) : null,
          ]
            .filter(Boolean)
            .join(" · ");
          console.error("[push] Не удалось отправить уведомление:", message, detail);
          void logSystemError("api", `Push-уведомление не отправлено: ${message}${detail ? ` (${detail})` : ""}`);
        }
        return 0;
      }
    })
  );
  return results.reduce<number>((sum, n) => sum + n, 0);
}

/**
 * Push всем устройствам одного агента.
 *
 * ЛЕНТА УВЕДОМЛЕНИЙ (17-18.08.2026): рядом с самим push пишем запись в Notification —
 * ОДНА точка вызова на всех подписчиков этой функции (их около трёх десятков по
 * всему API), а не правка каждого места отдельно. Пишем ВСЕГДА, даже если VAPID не
 * настроен или подписок у агента нет: push эфемерен, лента — постоянная история,
 * и колокольчик в шапке должен наполняться независимо от того, дошло ли устройство.
 * Сбой записи не должен ронять сам push — createNotification сама ловит ошибки.
 */
/**
 * ТИХИЕ ЧАСЫ (владелец 12.09.2026: «ночью запрещено слать пуши всем
 * пользователям, только в начале рабочего дня») — единая развилка для обоих
 * отправителей.
 *
 * Возвращает true, если пуш дальше НЕ идёт: он либо отложен до 08:00 через
 * очередь заданий, либо отброшен как теряющий смысл к утру. Запись в ленте
 * уведомлений к этому моменту уже создана вызывающей функцией — тишина
 * касается только звонка устройства (см. lib/pushQuietHours.ts).
 *
 * Экспортирована (21.09.2026) для вызывающих, которым нужна ТОЛЬКО доставка
 * устройству без повторной записи в ленту — см. `deliverPushToAgents` ниже
 * и разбор гонки в docs/TASKS.md («Счётчик повторов у алармов растёт вдвое
 * быстрее события»): `sendPushToAgents` сам пишет в ленту второй раз, без
 * ожидания, поверх уже сделанной вызывающим кодом записи.
 */
export async function handledByQuietHours(agentIds: string[], payload: PushPayload): Promise<boolean> {
  const decision = quietDecision(payload);
  if (decision === "send") return false;
  if (decision === "drop") return true;
  // Постановка best-effort, как и у остальных заданий: сбой очереди не имеет
  // права ронять само событие — запись в ленте уже есть.
  const queued = { agentIds, payload: wirePayloadForQueue(payload) };
  const dedupeKey = payload.tag ? `deferred-push:${payload.tag}:${agentIds.slice().sort().join(",")}` : null;
  await enqueueBackgroundJob({
    type: "deferred-push",
    payload: queued,
    maxAttempts: 3,
    runAt: quietHoursEndAfter(),
    // Одна тема — одно утреннее уведомление: за ночь один и тот же tag может
    // прийти десятки раз (клиент пишет подряд), и без ключа в 08:00 человек
    // получил бы стопку. Повторы схлопываются в одно задание.
    ...(dedupeKey ? { dedupeKey } : {}),
  });
  // ...но утром уходит ПОСЛЕДНЕЕ содержание темы, а не первое (E14 глубокой
  // проверки 02.10.2026): раньше выигрывала первая постановка за ночь, и в
  // 08:00 приходил текст 22:00, хотя к 23:00 по той же теме было уже другое.
  // Только ждущее задание: исполняющееся или завершённое не трогаем.
  if (dedupeKey) {
    await prisma.backgroundJob
      .updateMany({ where: { dedupeKey, type: "deferred-push", status: "PENDING" }, data: { payload: queued } })
      .catch((err) => console.error("[push] утреннее уведомление не обновлено:", err instanceof Error ? err.message : err));
  }
  return true;
}

/** Payload для хранения в задании: только поля, которые переживут JSON. */
function wirePayloadForQueue(payload: PushPayload): Prisma.InputJsonObject {
  const { close: _close, realtime: _realtime, ...rest } = payload;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Prisma.InputJsonObject;
}

/**
 * ТЕЛЕФОН КЛИЕНТА В ТЕКСТЕ УВЕДОМЛЕНИЯ — ТА ЖЕ УТЕЧКА, ЧТО И ПОЛЕ `phone`
 * (22.09.2026, ночной обход кода по классу «номер уходит мимо прав»).
 *
 * Правило `clients.viewPhone` соблюдали маршруты, отдающие карточку (см.
 * lib/clientPhone.ts), а канал уведомлений не знал о нём вовсе: напоминание о
 * показе, заявка на обратный звонок, голосовое сообщение и «клиент не
 * подтвердил» собирали строку вида «Мадина · +992910001003 — в 14:30» и слали
 * её обычному агенту. Хуже того, текст пуша тем же вызовом ложится в
 * `Notification.body` и живёт в колокольчике постоянно — то есть номер не
 * мелькал, а оседал.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В ПЯТИ МЕСТАХ, ГДЕ НАШЛОСЬ. Вызывающих у пушей около
 * тридцати, и каждый новый пуш — новый шанс забыть. Это та же мысль, ради
 * которой заведены lib/ownerContact.ts и lib/clientPhone.ts: правило,
 * записанное в одном вызывающем, правилом не является.
 *
 * ПОЧЕМУ УЗКИЙ РАЗБОР (maskPhonesInText), А НЕ maskPhonesInFreeText. Тело
 * пуша — не свободный текст, а собранная нами строка, и в ней рядом стоят
 * дата и время: «Показ 22.09.2026 14:30» даёт цепочку из десяти цифр с
 * разделителями, и добивка по цепочке превращает её в «2209•••••14:30».
 * Узкий разбор ловит всё, что реально утекало (номера хранятся как +992…),
 * и не портит дат. СВОБОДНЫЙ текст внутри пуша — расшифровка голосового,
 * тема заявки, написанная моделью, — обязан быть закрыт ВЫЗЫВАЮЩИМ через
 * phoneSafeText: здесь про него ничего не известно.
 *
 * ПО ПОЛУЧАТЕЛЮ, А НЕ ВСЕМ ПОДРЯД: запись в ленте своя у каждого сотрудника,
 * поэтому директор и администратор (право `clients.viewPhone`) по-прежнему
 * видят номер и могут позвонить прямо из уведомления.
 */
function maskPayloadPhones(payload: PushPayload): PushPayload {
  return { ...payload, title: maskPhonesInText(payload.title), body: maskPhonesInText(payload.body) };
}

export async function sendPushToAgent(agentId: string, payload: PushPayload): Promise<number> {
  if (!(await filterInvestigationRecipients([agentId], payload)).length) return 0;
  const { granted } = await partitionByPermission([agentId], "clients.viewPhone");
  if (granted.length === 0) payload = maskPayloadPhones(payload);
  void createNotification({
    agentId,
    kind: payload.kind ?? "other",
    // Уровень обязателен к передаче: эта запись схлопывается по tag с той, что
    // мог написать вызывающий код напрямую, и без него затёрла бы её важность
    // (см. PushPayload.level).
    level: payload.level,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });
  // Колокольчик в шапке — тем же одним местом, что и сама запись в ленту:
  // ~30 вызывающих, и publish в каждом из них разошёлся бы с реальностью
  // на первой же новой точке. Идёт ДО проверки тихих часов намеренно: ночью
  // молчит устройство, а запись в ленте появляется всегда (решение владельца
  // 12.09.2026), и открытый экран обязан её показать сразу.
  publishNotificationNew([agentId]);
  if (await handledByQuietHours([agentId], payload)) return 0;
  return deliverPushToAgents([agentId], payload);
}

/**
 * То же самое, но сразу нескольким агентам — ОДНИМ запросом к базе вместо запроса
 * на каждого. Рассылки руководству (эскалация лида, невозвращённый ключ) идут внутри
 * цикла по клиентам/ключам: там `for (const id of supervisors) sendPushToAgent(id)`
 * давал запрос на каждого руководителя на каждой записи — классический N+1, который
 * растёт произведением, а не суммой.
 */
export async function sendPushToAgents(agentIds: string[], payload: PushPayload): Promise<number> {
  agentIds = await filterInvestigationRecipients(agentIds, payload);
  if (agentIds.length === 0) return 0;
  // Телефон клиента — по получателю (см. maskPayloadPhones выше): один и тот же
  // текст уходит пачке сотрудников с разными правами, поэтому получатели
  // раскладываются на две группы и каждая получает свой вариант строки.
  const { granted, denied } = await partitionByPermission(agentIds, "clients.viewPhone");
  if (granted.length > 0 && denied.length > 0) {
    const [a, b] = await Promise.all([
      sendPushToAgentsSameText(granted, payload),
      sendPushToAgentsSameText(denied, maskPayloadPhones(payload)),
    ]);
    return a + b;
  }
  return sendPushToAgentsSameText(agentIds, granted.length > 0 ? payload : maskPayloadPhones(payload));
}

/** Рассылка одного и того же текста — то, чем `sendPushToAgents` была до
 *  разделения получателей по праву на телефон. */
async function sendPushToAgentsSameText(agentIds: string[], payload: PushPayload): Promise<number> {
  if (agentIds.length === 0) return 0;
  // Та же лента, что и в sendPushToAgent выше — единой записью на всех агентов.
  void createNotifications(agentIds, {
    kind: payload.kind ?? "other",
    // См. PushPayload.level: без этого второй проход по тому же tag понижает
    // важность до умолчания и вымывает раздел «Срочное».
    level: payload.level,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
  });
  publishNotificationNew(agentIds);
  if (await handledByQuietHours(agentIds, payload)) return 0;
  return deliverPushToAgents(agentIds, payload);
}

/**
 * ЧИСТАЯ ДОСТАВКА: подписки, личные отключения — и на устройство.
 *
 * БЕЗ записи в ленту уведомлений и БЕЗ проверки тихих часов. Вынесено из
 * sendPushToAgent(s) ради обработчика отложенных пушей (jobs/deferredPush.ts):
 * утром запись в ленте уже создана ночью, а вторая проверка тишины заставила бы
 * опоздавшее задание откладывать само себя по кругу.
 *
 * Снаружи этого модуля звать напрямую нельзя ничему, кроме того обработчика:
 * иначе пуш пройдёт мимо и ленты, и тихих часов.
 */
export async function deliverPushToAgents(agentIds: string[], payload: PushPayload): Promise<number> {
  agentIds = await filterInvestigationRecipients(agentIds, payload);
  if (!configured || agentIds.length === 0) return 0;
  // Только действующим сотрудникам (23.09.2026): отключённому уволенному на
  // телефон продолжали приходить пуши с именами и телефонами клиентов — клиенты
  // при отключении не передаются, и все поводы по ним шли на старые подписки.
  const subs = await prisma.pushSubscription.findMany({
    where: { agentId: { in: agentIds }, agent: { isActive: true } },
    include: { agent: { select: { pushMuted: true, pushDisabled: true } } },
  });
  const allowed = subs.filter((sub) => !sub.agent.pushDisabled && !isMuted(payload, sub.agent.pushMuted));
  return deliverToSubscriptions(allowed, payload);
}

/**
 * Гасит на устройствах агента уведомление с данным tag — лид ушёл к другому,
 * пока висел непринятым (владелец 19.08.2026): без этого пуш «🔔 Новый лид»
 * продолжает лежать в шторке и звать агента к карточке, которая уже не его.
 *
 * Не пишет в ленту уведомлений (createNotification) — это служебный сигнал
 * устройству, а не событие для истории; и не проверяет pushMuted — раз агент
 * отключил себе вид «lead», исходного пуша с этим tag у него на устройстве и
 * не было, закрывать нечего, лишний сигнал безвреден.
 */
export async function closeLeadPushNotification(agentId: string, tag: string): Promise<void> {
  if (!configured) return;
  const subs = await prisma.pushSubscription.findMany({ where: { agentId } });
  if (subs.length === 0) return;
  await deliverToSubscriptions(subs, { close: true, tag, title: "", body: "" });
}

/**
 * То же самое, что closeLeadPushNotification выше, но для нескольких (агент, tag)
 * сразу — ОДНИМ запросом к базе на все подписки, а не по запросу на каждую пару.
 *
 * Добавлено 20.08.2026: closeMeetingReminderPushes и ещё пять подобных обработчиков
 * звали closeLeadPushNotification внутри Promise.all(...map(...)) — тот же N+1,
 * который sendPushToAgents уже решил для ОТПРАВКИ (см. комментарий выше), просто
 * заново появился на пути ЗАКРЫТИЯ пуша.
 */
export async function closeLeadPushNotifications(entries: { agentId: string; tag: string }[]): Promise<void> {
  if (!configured || entries.length === 0) return;
  const agentIds = [...new Set(entries.map((e) => e.agentId))];
  const subs = await prisma.pushSubscription.findMany({
    where: { agentId: { in: agentIds } },
    select: { id: true, endpoint: true, p256dh: true, auth: true, agentId: true },
  });
  const byAgent = new Map<string, PushSubscriptionRow[]>();
  for (const sub of subs) {
    const list = byAgent.get(sub.agentId);
    if (list) list.push(sub);
    else byAgent.set(sub.agentId, [sub]);
  }
  await Promise.all(
    entries.map((e) => {
      const agentSubs = byAgent.get(e.agentId);
      return agentSubs ? deliverToSubscriptions(agentSubs, { close: true, tag: e.tag, title: "", body: "" }) : undefined;
    })
  );
}

/**
 * «🔔 Новая проблема в CRM» директору и администратору УБРАНА по решению владельца
 * 02.10.2026 (за 14 дней 3 121 срабатываний — спам). Ошибка по-прежнему пишется в
 * журнал (logSystemError → таблица ошибок) и попадает в утренний отчёт и на /health.
 *
 * Функция оставлена пустой заглушкой с прежней сигнатурой: её регистрируют крючком
 * onNewSystemError в index.ts и worker.ts (systemError.ts не может импортировать
 * push.ts — цикл), а менять точки входа ради удаления рассылки незачем.
 */
export async function notifyDirectorsAboutNewError(
  _source: SystemErrorSource,
  _message: string,
  _url?: string
): Promise<void> {
  // Намеренно пусто: рассылка убрана, запись в журнал идёт в logSystemError.
}

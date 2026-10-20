import { Router } from "express";
import { z } from "zod";
import { PUSH_KINDS, isPushKind, isReadOnlyRole, type PushActionResult } from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { isPushConfigured, getVapidPublicKey, sendPushToAgent } from "../push.js";
import { consumeLeadActionToken } from "../lib/pushLeadActions.js";
import { acceptLead } from "../lib/leadAccept.js";
import { declineLead } from "../leads.js";
import { logSystemError } from "../lib/systemError.js";
import { clientNamePhoneSafe } from "../lib/clientPhone.js";
import { partitionByPermission } from "../lib/recipients.js";

export const pushRouter = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/** Фронтенд узнаёт здесь, включён ли push на сервере, и берёт публичный VAPID-ключ для подписки. */
pushRouter.get("/config", requireAuth, (_req, res) => {
  res.json({ enabled: isPushConfigured(), publicKey: getVapidPublicKey() });
});

pushRouter.post("/subscribe", requireAuth, async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные подписки", details: parsed.error.flatten() });
  }
  const { endpoint, keys } = parsed.data;
  // upsert по endpoint: тот же браузер может переподписаться (например, после смены агента
  // на общем устройстве) — тогда подписка должна перейти к текущему вошедшему агенту.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { agentId: req.agent!.id, p256dh: keys.p256dh, auth: keys.auth, lastSeenAt: new Date() },
    create: { endpoint, agentId: req.agent!.id, p256dh: keys.p256dh, auth: keys.auth, lastSeenAt: new Date() },
  });
  res.status(201).json({ ok: true });
});

/** Тестовый пуш самому себе — кнопка «Проверить уведомления» в Профиле: без неё
 * невозможно отличить «пуши не настроены» от «просто не было событий». */
pushRouter.post("/test", requireAuth, async (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: "Push не настроен на сервере (VAPID-ключи)" });
  }
  const subs = await prisma.pushSubscription.count({ where: { agentId: req.agent!.id } });
  if (subs === 0) {
    return res.status(409).json({ error: "У вас нет подписанных устройств — включите уведомления выше" });
  }
  await sendPushToAgent(req.agent!.id, {
    title: "Проверка уведомлений",
    body: "Если вы видите это — уведомления CRM работают 🎉",
    url: "/",
    tag: "push-test",
  });
  res.json({ ok: true, devices: subs });
});

/**
 * Личные настройки: какие виды уведомлений сотрудник себе оставил.
 *
 * Хранятся ВЫКЛЮЧЕННЫЕ (Agent.pushMuted), а отдаются как «включено/выключено» по
 * каждому известному виду: интерфейсу нужен полный список, а базе — только то,
 * что человек снял. Новый вид уведомления при таком хранении доходит до всех сам.
 */
pushRouter.get("/preferences", requireAuth, async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.agent!.id },
    select: { pushMuted: true },
  });
  const muted = agent?.pushMuted ?? [];
  res.json({
    kinds: PUSH_KINDS.map((k) => ({ ...k, enabled: !muted.includes(k.key) })),
  });
});

pushRouter.patch("/preferences", requireAuth, async (req, res) => {
  const parsed = z
    .object({ kind: z.string().refine(isPushKind, "Неизвестный вид уведомления"), enabled: z.boolean() })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { pushMuted: true } });
  const current = new Set(agent?.pushMuted ?? []);
  if (parsed.data.enabled) current.delete(parsed.data.kind);
  else current.add(parsed.data.kind);

  await prisma.agent.update({ where: { id: req.agent!.id }, data: { pushMuted: [...current] } });
  res.json({ kinds: PUSH_KINDS.map((k) => ({ ...k, enabled: !current.has(k.key) })) });
});

const actionSchema = z.object({
  token: z.string().min(20).max(200),
  action: z.enum(["lead-accept", "lead-decline"]),
});

/**
 * Кнопка «Принять»/«Отклонить», нажатая прямо в шторке уведомлений.
 *
 * ЕДИНСТВЕННЫЙ маршрут CRM без requireAuth, доступный за пределами входа, и это
 * осознанно: у service worker нет JWT (он живёт вне вкладки и не видит её
 * хранилища). Вместо токена доступа — одноразовый маркер, приехавший в самом
 * уведомлении: привязан к паре «агент + клиент», разрешает ровно два действия по
 * ровно одному лиду, живёт минуты и сжигается атомарно (lib/pushLeadActions.ts).
 *
 * Ответ всегда 200 с человеческим текстом, а не код ошибки: его показывает
 * уведомление-итог, и агент должен прочитать «лид уже принят», а не «409».
 * Разбирать статусы в service worker было бы второй реализацией текстов.
 *
 * МАРКЕР СЖИГАЕТСЯ ДО ДЕЙСТВИЯ, а не после. Одно уведомление приходит на все
 * устройства агента, поэтому повторное нажатие — обычное дело, и защита от него
 * важнее, чем возможность нажать второй раз, когда действие не прошло. Там, где
 * действие не завершилось (полный портфель требует выбрать, кого отдать), агент
 * отправляется в карточку — этот случай в тексте назван прямо.
 */
pushRouter.post("/action", async (req, res) => {
  const parsed = actionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.json({ ok: false, message: "Уведомление устарело — откройте CRM" } satisfies PushActionResult);
  }

  const consumed = await consumeLeadActionToken(parsed.data.token);
  if (!consumed.ok) {
    const message =
      consumed.reason === "used"
        ? "Это уведомление уже отработано"
        : consumed.reason === "expired"
          ? "Уведомление устарело — откройте карточку в CRM"
          : "Действие недоступно — откройте CRM";
    return res.json({ ok: false, message } satisfies PushActionResult);
  }

  // Маркер выдан по роли НА МОМЕНТ УВЕДОМЛЕНИЯ, а действие приходит позже: роль
  // могли сменить на «только просмотр», учётку — отключить. Роут идёт без
  // requireAuth, поэтому обе проверки повторяются здесь (ревью Codex 10.10.2026:
  // старый пуш-маркер сохранял бизнес-действие после смены роли на акционера).
  const actor = await prisma.agent.findUnique({
    where: { id: consumed.agentId },
    select: { role: true, isActive: true },
  });
  if (!actor || !actor.isActive || isReadOnlyRole(actor.role)) {
    return res.json({ ok: false, message: "Действие недоступно — откройте CRM" } satisfies PushActionResult);
  }

  const client = await prisma.client.findUnique({
    where: { id: consumed.clientId },
    select: { shortId: true, fullName: true },
  });
  const url = client ? `/clients/${client.shortId}` : "/clients";

  try {
    if (parsed.data.action === "lead-accept") {
      const outcome = await acceptLead({ clientId: consumed.clientId, agentId: consumed.agentId });
      if (outcome.ok) {
        // Имя — по праву ПОЛУЧАТЕЛЯ уведомления (A11, глубокая проверка
        // 02.10.2026): здесь нет req.agent, агент известен из маркера. У старых
        // карточек незнакомых звонивших номер лежит в самом имени.
        const { granted } = await partitionByPermission([consumed.agentId], "clients.viewPhone");
        const name = client ? clientNamePhoneSafe(client.fullName, granted.length > 0) : "Лид";
        return res.json({ ok: true, message: `${name} принят — контакты открыты`, url });
      }
      if (outcome.requiresRelease) {
        return res.json({
          ok: false,
          message: "Портфель полон — откройте карточку и выберите, кого передать",
          url,
        } satisfies PushActionResult);
      }
      return res.json({ ok: false, message: outcome.error, url } satisfies PushActionResult);
    }

    const result = await declineLead(consumed.clientId, consumed.agentId);
    if (result.ok) {
      return res.json({
        ok: true,
        message: result.reassignedTo ? "Лид отклонён и передан следующему агенту" : "Лид отклонён и передан руководителю",
        url,
      });
    }
    const message =
      result.reason === "already_accepted"
        ? "Лид уже принят — отклонить его больше нельзя"
        : result.reason === "not_found"
          ? "Клиент не найден"
          : "Лид уже не за вами";
    return res.json({ ok: false, message, url } satisfies PushActionResult);
  } catch (err) {
    await logSystemError("api", `Действие из push: ${err instanceof Error ? err.message : String(err)}`);
    return res.json({ ok: false, message: "Не удалось выполнить — откройте карточку в CRM", url });
  }
});

pushRouter.post("/unsubscribe", requireAuth, async (req, res) => {
  const parsed = z.object({ endpoint: z.string().url() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Неверные данные" });
  await prisma.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint, agentId: req.agent!.id } });
  res.json({ ok: true });
});

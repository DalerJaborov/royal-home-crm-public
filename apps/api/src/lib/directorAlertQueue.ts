import {
  isPushKind,
  notificationLevelOf,
  type NotificationLevel,
  type PermissionId,
  type Role,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { createNotifications } from "./notifications.js";
import { isWithinAlarmHours } from "./workingHours.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";

/**
 * ОЧЕРЕДЬ АЛАРМОВ РУКОВОДСТВУ (владелец 07.09.2026) — см. doc-comment у модели
 * PendingDirectorAlert в schema.prisma за полным объяснением, зачем это вообще
 * понадобилось (аудит нашёл больше 20 мест, слающих пуш директору/руководству
 * напрямую, в любой час).
 *
 * ИСПОЛЬЗОВАНИЕ: там, где раньше стояло что-то вроде
 *   await createNotifications(recipients, payload);
 *   void sendPushToAgents(recipients, payload);
 * теперь:
 *   await enqueueDirectorAlert({ ...payload, recipientPermission: "clients.assign" });
 * Само событие (клик агента, крон-тик, звонок) остаётся мгновенным и ничего
 * не ждёт — enqueueDirectorAlert только пишет строку в БД. Доставка происходит
 * позже, отдельным сборщиком flushDirectorAlertQueue.
 */

interface EnqueueParams {
  title: string;
  body: string;
  url?: string | null;
  kind?: string;
  /** Важность (владелец 09.09.2026). Не задана — выводится из kind при доставке.
   *  Задавать явно нужно только там, где умолчание врёт: «агент бросил клиента» и
   *  еженедельная сводка о дублях не одного веса, хотя kind у них один. */
  level?: NotificationLevel;
  tag?: string | null;
  /** Ровно один из этих двух: право (findAgentsWithPermission) или роли (Agent.role). */
  recipientPermission?: PermissionId;
  recipientRoles?: Role[];
  /** Не слать этому агенту, даже если он входит в право/роли выше (например,
   *  директор не должен получить дубль о своём же новом устройстве). */
  excludeAgentId?: string;
}

export async function enqueueDirectorAlert(params: EnqueueParams): Promise<void> {
  try {
    await prisma.pendingDirectorAlert.create({
      data: {
        title: params.title,
        body: params.body,
        url: params.url ?? null,
        kind: params.kind ?? null,
        level: params.level ?? null,
        tag: params.tag ?? null,
        recipientPermission: params.recipientPermission ?? null,
        recipientRoles: params.recipientRoles ?? [],
        excludeAgentId: params.excludeAgentId ?? null,
      },
    });
  } catch (err) {
    console.error("[directorAlertQueue] не удалось поставить аларм в очередь:", err);
    // И в журнал ошибок (07.10.2026): аларм руководству, который не встал в очередь,
    // раньше исчезал только строкой в консоли — самого сигнала о потере не было.
    void logSystemError(
      "api",
      `Не удалось поставить аларм руководству в очередь («${params.title}»): ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: `director-alert-enqueue-failed:${params.tag ?? params.title}` }
    );
  }
}

/**
 * Сколько строка может пролежать в очереди, постоянно падая при доставке, прежде чем
 * её закроют как проваленную. Короткий сбой (БД, поиск получателей) должен переждаться и
 * доставиться на следующем проходе (CHANNEL-NEW-03), но по-настоящему битая строка
 * (например неожиданное значение в recipientRoles) не должна копиться вечно.
 */
const FAILED_ROW_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Запасные получатели алармов, когда у права/ролей не осталось никого. */
const FALLBACK_ROLES: Role[] = ["DIRECTOR", "ADMIN"];
const FALLBACK_CACHE_KEY = "fallback:director-admin";

/**
 * СБОРЩИК: разбирает очередь, только пока идут часы алармов
 * (Settings.alarmHoursStart/End) — накопленное ночью уходит одной пачкой,
 * как только окно откроется. Получателей ищем СЕЙЧАС, а не берём снапшот из
 * момента постановки в очередь — состав правообладателей/директоров мог
 * измениться за время ожидания.
 */
export async function flushDirectorAlertQueue(now: Date = new Date()): Promise<number> {
  if (!(await isWithinAlarmHours(now))) return 0;

  const pending = await prisma.pendingDirectorAlert.findMany({
    where: { sentAt: null },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  if (pending.length === 0) return 0;

  // Кэш «право/роли → список агентов» на этот проход очереди: десятки строк в
  // очереди почти всегда бьют по одной и той же горстке прав — не спрашивать
  // БД по кругу на каждую строку. Исключение (excludeAgentId) применяется
  // ПОСЛЕ кэша — своё для каждой строки, в общий список получателей не входит.
  const recipientCache = new Map<string, string[]>();
  async function resolveRecipients(item: {
    title: string;
    recipientPermission: string | null;
    recipientRoles: string[];
    excludeAgentId: string | null;
  }): Promise<{ resolved: string[]; filtered: string[]; fallback: boolean }> {
    const cacheKey = item.recipientPermission ? `perm:${item.recipientPermission}` : `roles:${item.recipientRoles.slice().sort().join(",")}`;
    let resolved = recipientCache.get(cacheKey);
    if (!resolved) {
      resolved = item.recipientPermission
        ? await findAgentsWithPermission(item.recipientPermission as PermissionId)
        : (
            await prisma.agent.findMany({
              where: { role: { in: item.recipientRoles as Role[] }, isActive: true },
              select: { id: true },
            })
          ).map((a) => a.id);
      recipientCache.set(cacheKey, resolved);
    }
    let fallback = false;
    // НИКОМУ НЕ УШЛО — НЕ «ДОСТАВЛЕНО» (07.10.2026, класс «тихая потеря»). Раньше
    // строка без получателей помечалась отправленной «в никуда»: право отозвали
    // у всех или роль опустела — и аларм исчезал без следа. Теперь запасные
    // получатели — директор и администратор, а если нет и их, строка остаётся
    // в очереди (см. ниже), а в журнале ошибок появляется запись.
    if (resolved.length === 0) {
      let fallbackIds = recipientCache.get(FALLBACK_CACHE_KEY);
      if (!fallbackIds) {
        fallbackIds = (
          await prisma.agent.findMany({ where: { role: { in: [...FALLBACK_ROLES] }, isActive: true }, select: { id: true } })
        ).map((a) => a.id);
        recipientCache.set(FALLBACK_CACHE_KEY, fallbackIds);
      }
      void logSystemError(
        "api",
        `Аларм «${item.title}»: ${
          item.recipientPermission ? `у права ${item.recipientPermission}` : `у ролей ${item.recipientRoles.join(", ") || "—"}`
        } нет ни одного получателя${fallbackIds.length > 0 ? " — отправлено директору и администратору" : ", запасных получателей тоже нет"}`,
        { dedupKey: `director-alert-no-recipients:${item.recipientPermission ?? item.recipientRoles.join(",")}` }
      );
      resolved = fallbackIds;
      fallback = true;
    }
    return {
      resolved,
      filtered: item.excludeAgentId ? resolved.filter((id) => id !== item.excludeAgentId) : resolved,
      fallback,
    };
  }

  let sent = 0;
  for (const item of pending) {
    try {
      const { resolved, filtered: recipients } = await resolveRecipients(item);
      if (resolved.length === 0) {
        // Получателей нет совсем (даже запасных) — оставляем в очереди до появления
        // получателя, но не дольше FAILED_ROW_GIVE_UP_MS, иначе строки копились бы
        // и забивали выборку в 200 штук.
        if (now.getTime() - item.createdAt.getTime() > FAILED_ROW_GIVE_UP_MS) {
          await prisma.pendingDirectorAlert.update({ where: { id: item.id }, data: { sentAt: now } });
        }
        continue;
      }
      if (recipients.length > 0) {
        // Лента (Notification.kind) принимает любую строку — исторически сюда
        // писали и то, что вообще не push-уведомление, а только запись в ленте
        // (например "finance" в lib/financeAutomation.ts). PushPayload.kind —
        // строгий PushKind (влияет на иконку и на личные настройки «отключить
        // этот вид» в приложении), поэтому для самого push подставляем
        // безопасный запасной вариант "oversight", если пришло что-то чужое —
        // это семейство алармов и так «контроль руководителя» по смыслу.
        const pushKind = isPushKind(item.kind) ? item.kind : "oversight";
        // ВАЖНО: sendPushToAgents САМА пишет в ленту тем же payload (см.
        // push.ts:212-221, void createNotifications внутри, ровно тот же приём,
        // что и у остальных алармов CRM: явный await ниже — чтобы тесты видели
        // Notification сразу, а вызов sendPushToAgents всё равно допишет её
        // же строку вторым проходом). БЕЗ TAG это было бы не «лишний count»,
        // а ДВЕ РАЗНЫЕ СТРОКИ (без tag createNotifications всегда вставляет
        // новую, upsertByTag не при делах) — часть исторических вызовов,
        // например lib/financeAutomation.ts, tag никогда не задавала. Поэтому
        // здесь ГАРАНТИРУЕМ tag сами (id строки очереди, если вызывающий код
        // свой не передал) — тогда оба прохода бьют в один и тот же
        // (agentId, tag) и upsertByTag схлопывает их в одну строку.
        const tag = item.tag ?? `director-alert-${item.id}`;
        await createNotifications(recipients, {
          kind: item.kind ?? "oversight",
          // Уровень пролежал в очереди вместе с алармом: разбор ночного
          // накопления не имеет права понизить срочность до умолчания.
          level: notificationLevelOf(item.kind, item.level),
          title: item.title,
          body: item.body,
          url: item.url,
          tag,
        });
        void sendPushToAgents(recipients, {
          kind: pushKind,
          title: item.title,
          body: item.body,
          url: item.url ?? undefined,
          tag,
        }).catch((err) => console.error("[directorAlertQueue] push:", err));
        sent++;
      }
      await prisma.pendingDirectorAlert.update({ where: { id: item.id }, data: { sentAt: now } });
    } catch (err) {
      console.error("[directorAlertQueue] доставка строки очереди:", err);
      // Свежую строку оставляем в очереди: временный отказ БД не должен молча терять
      // аларм (аудит Codex 04.10, CHANNEL-NEW-03; следующие проходы читают только
      // sentAt: null). Закрываем, только когда она падает уже сутки, — иначе одна
      // поломанная запись (например неожиданное значение в recipientRoles)
      // блокировала бы себя же на каждом проходе очереди навсегда, засоряя журнал.
      if (now.getTime() - item.createdAt.getTime() > FAILED_ROW_GIVE_UP_MS) {
        await prisma.pendingDirectorAlert.update({ where: { id: item.id }, data: { sentAt: now } }).catch(() => {});
      }
    }
  }
  return sent;
}

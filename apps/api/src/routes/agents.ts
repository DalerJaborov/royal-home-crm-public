import { Router, type Request, type Response } from "express";
import { Prisma } from "../generated/prisma/client.js";
import {
  agentCreateSchema,
  agentFreezeSchema,
  supervisorLeadPauseSchema,
  agentHandoverSchema,
  agentUpdateSchema,
  describePermissions,
  normalizeOverrides,
  parsePermissionOverrides,
  permissionOverridesSchema,
  resolvePermissions,
  ROLE_PRESET_SUMMARY,
  type Role,
  SALES_AGENT_ROLES,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { can, invalidateAgentAccess, requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { syncAgentQueuePresence } from "../lib/telephony/operatorQueue.js";
import { syncAgentMobileFallback } from "../lib/telephony/agentMobileFallback.js";
import {
  checkIncomingReadiness,
  describeNewAgentQueueOutcome,
  ensureAgentsInIncomingQueue,
} from "../lib/telephony/agentIncomingReadiness.js";
import { ensureExtensionRecording } from "../lib/telephony/extensionPool.js";
import { revokeOtherSessions } from "../lib/sessions.js";
import { closeStreamsForAgent } from "../lib/eventBus.js";
import { agentHasCascadeHistory } from "../lib/agentHistory.js";
import { revokeElevation } from "../lib/stepUp.js";
import { requireElevation } from "../lib/stepUp.js";
import { upload } from "../upload.js";
import { removeAgentAvatarFile, saveAgentAvatarFile } from "../lib/agentAvatarFile.js";
import { handoverAgentWork } from "../lib/agentHandover.js";
import { revertAgentHandover } from "../lib/agentHandoverRevert.js";
import { releaseReactivationOffersOfAgent } from "../lib/reactivationOffers.js";
import { shiftInactiveClockAfterAbsence } from "../lib/inactiveTrafficLight.js";
import { findUnacceptedLeadsOfAgent, releaseLeadsToQueue, type ReleasableLead } from "../lib/agentLeadRelease.js";
import { clearAgentFromSettingsReferences } from "../lib/agentSettingsCleanup.js";
import { endLeadPause, notifyAgentAboutSupervisorPause, startLeadPause } from "../lib/agentLeadPause.js";
import { availabilityOf } from "../lib/agentAvailability.js";
import { sendPushToAgents } from "../push.js";
import { logSystemError } from "../lib/systemError.js";
import {
  checkManualExtension,
  getExtensionStatuses,
  pickFreeExtension,
  readExtensionPool,
} from "../lib/telephony/extensionPool.js";
import {
  loadAgentDialMode,
  loadAriCredentials,
  originateCall,
  resolveAgentDialTarget,
} from "../lib/telephony/ariClient.js";
import { beginOrigination, endOrigination, hasLiveCall } from "../lib/telephony/callTracker.js";
import { sumPointsByAgent } from "../lib/pointsTotals.js";
import { anyParams } from "../lib/routeParams.js";

export const agentsRouter = Router();

// Управление учётками (создание/правка/удаление/аватар) — только ADMIN(+DIRECTOR).
// Журнал баллов на чтение доступен и MANAGER (тот же круг, что видит /team), поэтому
// авторизация проверяется здесь, а роль — по каждому роуту отдельно, а не одним общим use().
agentsRouter.use(requireAuth);

/** Учётки директоров и выдача роли DIRECTOR — только для директора: админ не может
 * создать директора, изменить или удалить его учётку. */
async function forbiddenDirectorTarget(req: Request, targetId?: string, requestedRole?: string): Promise<boolean> {
  if (req.agent!.role === "DIRECTOR") return false;
  if (requestedRole === "DIRECTOR") return true;
  if (targetId) {
    const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true } });
    if (target?.role === "DIRECTOR") return true;
  }
  return false;
}

/**
 * Роль — это тот же набор прав, поэтому её назначение подчиняется правилу
 * «раздавать права может тот, у кого есть permissions.manage» (см. комментарий
 * у /:id/permissions). Без этой проверки защита была декоративной: `agents.manage` —
 * обычная галочка, не связанная с permissions.manage, и обладатель одним PATCH
 * ставил себе ADMIN, получая settings.manage, clients.purge, calls.transcripts и
 * clients.viewPhone. Второй путь — завести себе новую ADMIN-учётку с чистым
 * пресетом в обход персонального отзыва прав.
 *
 * С 14.09.2026 (решение владельца: ADMIN = DIRECTOR целиком) permissions.manage —
 * обычное ASSIGNABLE-право в пресете ADMIN, поэтому админ проходит эту проверку
 * так же, как директор, и может назначать роль ADMIN (себе и другим) — это
 * осознанный выбор, не дыра. Роль DIRECTOR эта функция по-прежнему не пускает
 * никого, кроме директора, — см. forbiddenDirectorTarget выше, отдельная,
 * непересекающаяся защита именно учётки владельца.
 *
 * Возвращает текст отказа или null, если всё в порядке.
 */
function forbiddenRoleGrant(req: Request, targetId: string | undefined, requestedRole?: string): string | null {
  if (!requestedRole) return null;
  if (can(req, "permissions.manage")) return null;
  if (targetId && targetId === req.agent!.id) {
    return "Нельзя менять собственную роль";
  }
  if (requestedRole === "ADMIN") {
    return "Назначать администратора может только тот, у кого есть право раздавать права";
  }
  return null;
}

/**
 * Учётку того, кто раздаёт права (permissions.manage — пресет ADMIN или личная
 * галочка), правит, отключает, замораживает и удаляет только тот, у кого это
 * право тоже есть (G5, 02.10.2026). Иначе запрет forbiddenRoleGrant обходился
 * в один шаг: держатель agents.manage сбрасывал пароль и телефон-логин админу,
 * входил под ним и получал всё, что ему запрещено назначать.
 */
async function forbiddenPrivilegedTarget(req: Request, targetId: string): Promise<boolean> {
  if (can(req, "permissions.manage")) return false;
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, permissions: true } });
  if (!target) return false;
  return resolvePermissions(target.role as Role, parsePermissionOverrides(target.permissions)).has("permissions.manage");
}
const PRIVILEGED_TARGET_ERROR = "Управлять учёткой сотрудника, который раздаёт права, может только тот, у кого есть это право";

/** true, если после смены роли/деактивации в системе не останется ни одного активного директора. */
async function wouldLoseLastDirector(targetId: string, data: { role?: string; isActive?: boolean }): Promise<boolean> {
  const demoted = data.role !== undefined && data.role !== "DIRECTOR";
  const deactivated = data.isActive === false;
  if (!demoted && !deactivated) return false;
  const target = await prisma.agent.findUnique({ where: { id: targetId }, select: { role: true, isActive: true } });
  if (!target || target.role !== "DIRECTOR" || !target.isActive) return false;
  const activeDirectors = await prisma.agent.count({ where: { role: "DIRECTOR", isActive: true } });
  return activeDirectors <= 1;
}

/**
 * Список сотрудников. Менеджеру он тоже нужен — ему разрешено назначать лиды
 * (POST /clients/:id/assign) и менять риелтора объекта, но список был закрыт под
 * ADMIN, из-за чего выпадающий список агентов у него приходил пустым и разрешённое
 * действие нельзя было выполнить из интерфейса. Отдаём менеджеру справочник без
 * учётных данных: контакты, роль и KPI коллег — это админская зона.
 */
agentsRouter.get("/", requirePermission("agents.manage", "clients.assign", "team.viewFull"), async (req, res) => {
  const isAdmin = can(req, "agents.manage");
  const agents = await prisma.agent.findMany({
    select: isAdmin
      ? {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          role: true,
          isActive: true,
          avatarUrl: true,
          createdAt: true,
          kpi: true,
          sipExtension: true,
          whisperLanguage: true,
          /// Ник в Instagram (26.09.2026) — показывается и правится в карточке
          /// сотрудника, см. lib/instagramCollaborators.ts.
          instagramUsername: true,
          /**
           * ПРИЗНАК ОПЕРАТОРА ПЕРВОЙ ЛИНИИ ОБЯЗАН БЫТЬ В ОТВЕТЕ (владелец
           * 20.09.2026: «настройки ставлю, обновляется и пропадает всё»).
           *
           * Поле сохранялось правильно, но списком не возвращалось, и карточка
           * после обновления снова показывала «Нет» — с виду настройка не
           * применялась вовсе. Поле, не попавшее в select, интерфейс молча
           * читает как пустое: та же ловушка, что у frozenAt ниже.
           */
          takesUnknownCalls: true,
          // «Присылать мои посты в Telegram» (28.09.2026, карточка сотрудника) —
          // тот же класс находки, что у takesUnknownCalls выше: поле, не попавшее
          // в select, список молча не покажет, даже если PATCH его сохранил.
          sharePostTelegram: true,
          // Личные выходные (11.10.2026) — тот же класс, что takesUnknownCalls выше:
          // не попав в select, после сохранения карточка показала бы «выходных нет».
          weeklyDaysOff: true,
          // Срез «Замороженные» в Настройках → Сотрудники (макет владельца).
          //
          // Вид и срок отсутствия (владелец 09.09.2026) — в ОБЕИХ ветках select:
          // по этому списку выбирают, кому передать клиента или дела, и
          // предложить человека, которого нет на работе, — ровно та ошибка, от
          // которой уводит вся лестница алармов. Поле, не попавшее в select,
          // фильтр молча не проверяет: отсев был бы написан и не срабатывал.
          frozenAt: true,
          absenceKind: true,
          absenceUntil: true,
        }
      : {
          id: true,
          fullName: true,
          role: true,
          isActive: true,
          avatarUrl: true,
          frozenAt: true,
          absenceKind: true,
          absenceUntil: true,
          // Кому передать клиента — видно, у кого сегодня выходной (11.10.2026).
          weeklyDaysOff: true,
        },
    // Новые сотрудники — сверху, чтобы сразу видеть недавно добавленных.
    orderBy: { createdAt: "desc" },
    // Потолок обязателен даже там, где сотрудников десяток — см. hallOfFame.ts.
    take: 500,
  });
  if (!isAdmin) return res.json(agents);
  // Директору к номеру добавляется состояние трубки: «номер выдан» и «телефон
  // работает» — разные вещи, и вторая до сих пор была видна только на самой АТС.
  // Запрос к АТС необязательный: не ответила — список всё равно отдаём.
  const { statuses, problem: stationProblem } = await getExtensionStatuses();
  /**
   * «ПОЛУЧАЕТ ЛИ ЧЕЛОВЕК ОБЩИЕ ВХОДЯЩИЕ» — третья, до 19.09.2026 отсутствовавшая
   * отметка (жалоба владельца про новых сотрудников Сурайё и Комрона).
   *
   * Номер выдан и трубка на связи — это ещё не значит, что станция станет ему
   * звонить: для общих входящих номер должен числиться участником очереди, а её
   * состав CRM не меняет (см. lib/telephony/agentIncomingReadiness.ts). Пока
   * отметки не было, дыра выглядела как «у нового сотрудника просто не работают
   * входящие» — без единого места, где это видно.
   */
  // Тем же правилом, что и запрос состояния трубок выше: список сотрудников
  // обязан открываться, даже если станция сейчас не отвечает.
  const readiness = (await checkIncomingReadiness().catch(() => null)) ?? {
    gaps: [],
    extra: [],
    problem: "АТС недоступна",
  };
  const gapIds = new Set(readiness.gaps.map((g) => g.agentId));
  // Кто получает незнакомые звонки, не будучи оператором (решение владельца
  // 20.09.2026). Живёт эта отметка недолго — сверка убирает таких из очереди
  // каждые 15 минут, — но до первого обхода директор обязан видеть правду.
  const extraIds = new Set((readiness.extra ?? []).map((g) => g.agentId));
  res.json(
    agents.map((a) => {
      const ext = "sipExtension" in a && typeof a.sipExtension === "string" ? a.sipExtension : null;
      // Состояние браузерной трубки (`webrtc`) отсюда убрано 18.08.2026 вместе с
      // самим софтфоном: звонки идут только на аппарат/мобильный, и «онлайн ли
      // номер» — теперь единственное, что про телефон сотрудника можно сказать.
      return {
        ...a,
        // null — про трубку судить НЕЛЬЗЯ: станция не ответила. Раньше здесь стояло
        // молчаливое false, и один сорванный запрос к АТС печатал директору девять
        // строк «трубка не подключена, звонки не доходят» про исправные телефоны
        // (жалоба владельца 20.09.2026). Ложная тревога дороже отсутствия отметки.
        phoneOnline: ext ? (stationProblem ? null : (statuses.get(ext)?.online ?? false)) : null,
        // null — судить нельзя (АТС не ответила или номера нет вовсе), а не
        // «всё хорошо»: молчаливое false обвиняло бы станцию в свой же обрыв.
        incomingQueueReady: readiness.problem || !ext ? null : !gapIds.has(a.id),
        // true — станция звонит ему незнакомыми, хотя оператором он не назначен.
        takesUnknownCallsUnexpected: readiness.problem || !ext ? null : extraIds.has(a.id),
      };
    })
  );
});

/**
 * Свободные внутренние номера — подсказка для поля «Внутр. номер (SIP)».
 * Директор не обязан помнить, что заведено на станции: до этого он вписывал номер
 * наугад, а узнавал об ошибке только когда сотруднику переставали доходить звонки.
 * Тот же источник, что и у автовыдачи (extensionPool), второго списка не заводим.
 */
agentsRouter.get("/extensions/free", requirePermission("agents.manage"), async (_req, res) => {
  const pool = await readExtensionPool();
  res.json({ free: pool.free, problem: pool.problem ?? null });
});

agentsRouter.post("/", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const parsed = agentCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const rest = parsed.data;
  if (await forbiddenDirectorTarget(req, undefined, rest.role)) {
    return res.status(403).json({ error: "Создавать директора может только директор" });
  }
  const roleDenied = forbiddenRoleGrant(req, undefined, rest.role);
  if (roleDenied) {
    return res.status(403).json({ error: roleDenied });
  }

  const existing = await prisma.agent.findUnique({ where: { phone: rest.phone } });
  if (existing) {
    return res.status(409).json({ error: "Агент с таким телефоном уже существует" });
  }

  // Внутренний номер выдаётся сам, если директор не вписал его вручную: сотрудник
  // должен иметь возможность звонить с первого дня, а не после отдельного похода на
  // АТС, о котором легко забыть. Номер берётся из пула, заведённого на FreePBX
  // (см. lib/telephony/extensionPool.ts). Отказ телефонии тут не критичен — человек
  // всё равно заводится, номер можно проставить позже.
  let sipExtension = rest.sipExtension ?? null;
  let extensionNote: string | undefined;
  if (!sipExtension) {
    const picked = await pickFreeExtension();
    sipExtension = picked.extension;
    extensionNote = picked.reason;
  } else {
    // Вписанный руками номер проверяется так же, как при правке карточки: пул сам
    // ошибиться не может, а поле ввода принимало любую опечатку.
    const check = await checkManualExtension(sipExtension);
    if (!check.ok) return res.status(409).json({ error: check.error });
    extensionNote = check.warning;
  }

  // Паролей нет (19.10.2026): сотрудник входит по коду из СМС/пуша или отпечатком.
  const agent = await prisma.agent.create({
    data: { ...rest, sipExtension },
  });
  // Заведение учётки — действие того же веса, что заморозка и смена прав, которые
  // журнал пишет давно: без этой записи появление сотрудника в системе нечем
  // подтвердить после того, как учётку удалили (12.09.2026).
  logAudit(req, "AGENT_CREATE", "Agent", agent.id, {
    fullName: agent.fullName,
    role: agent.role,
    sipExtension: agent.sipExtension,
  });
  // Мобильное плечо на станции — сразу, а не после первой жалобы «клиент не
  // дозвонился»: см. agentMobileFallback.ts (там же — почему только role=AGENT
  // и почему не через Follow Me станции).
  if (agent.sipExtension) void syncAgentMobileFallback(agent.id).catch(() => {});
  // Запись разговоров — сразу же, а не только для тех, кому её включил вручную
  // администратор станции (21.09.2026, просьба владельца «включить всегда у
  // любого нового сотрудника», см. extensionPool.ts). Отказ телефонии здесь не
  // критичен: сотрудник уже заведён, сверка сторожа (stationHealth.ts) догонит.
  if (agent.sipExtension) void ensureExtensionRecording(agent.sipExtension).catch(() => {});
  /**
   * ТРЕТИЙ ШАГ — ОЧЕРЕДЬ ВХОДЯЩИХ, СРАЗУ И САМА (19.09.2026, просьба владельца
   * «чтобы всегда, даже когда новых добавляем, тоже всё сработало в будущем»).
   *
   * Номер выдан и мобильное плечо прописано — но пока номер не числится в
   * очереди, общие входящие до человека не доходят вовсе: ровно то, на что
   * владелец пожаловался по Сурайё и Комрону. Теперь CRM дописывает участника
   * сама (см. lib/telephony/agentIncomingReadiness.ts), а обход раз в 15 минут
   * возвращает его на место после «Apply Config» на станции.
   *
   * Не вышло — не ошибка заведения: человек нужен в системе сразу, а очередь
   * подхватит тот же обход. Но директору об этом говорим прямо здесь, в ответе
   * на заведение: это единственный момент, когда он точно смотрит на экран.
   * Отметка в списке сотрудников подстрахует, если он его пропустил.
   */
  if (agent.sipExtension && (SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) {
    const fix = await ensureAgentsInIncomingQueue().catch(() => null);
    // Что именно говорить — решает помощник: в очередь положены только операторы
    // (правило 20.09.2026), и «не добавили» для обычного агента — не поломка, а
    // норма. Разбор ложной тревоги 22.10.2026 — в его шапке.
    const note = describeNewAgentQueueOutcome(
      { sipExtension: agent.sipExtension, takesUnknownCalls: agent.takesUnknownCalls },
      fix
    );
    if (note) extensionNote = extensionNote ? `${extensionNote}. ${note}` : note;
  }
  res.status(201).json({
    id: agent.id,
    fullName: agent.fullName,
    phone: agent.phone,
    role: agent.role,
    sipExtension: agent.sipExtension,
    // Причина показывается директору в интерфейсе: «номер не выдан, потому что…» —
    // молчаливое отсутствие номера выглядело бы как ошибка сохранения.
    extensionNote,
  });
});

agentsRouter.patch("/:id", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const parsed = agentUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const rest = parsed.data;
  // Несуществующий сотрудник — 404, а не P2025 из update ниже → 500 и строка в
  // журнале ошибок (ночная проверка 24.09.2026, №152).
  const target = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!target) return res.status(404).json({ error: "Сотрудник не найден" });
  if (await forbiddenDirectorTarget(req, req.params.id, rest.role)) {
    return res.status(403).json({ error: "Управлять учёткой директора может только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, req.params.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }
  const roleDenied = forbiddenRoleGrant(req, req.params.id, rest.role);
  if (roleDenied) {
    return res.status(403).json({ error: roleDenied });
  }
  if (await wouldLoseLastDirector(req.params.id, rest)) {
    return res.status(409).json({ error: "В системе должен остаться хотя бы один активный директор" });
  }

  /**
   * ВНУТРЕННИЙ НОМЕР, ВПИСАННЫЙ РУКАМИ, ПРОВЕРЯЕТСЯ.
   *
   * До этого PATCH сохранял поле как есть: несуществующий номер уходил в базу молча
   * (звонки сотруднику потом просто не доходили, и причина — опечатка — была нигде не
   * видна), а чужой номер разрешалось забрать, ломая связь сразу двоим.
   *
   * null (очистка номера) проверять не нужно и нельзя запрещать: снять номер —
   * законное действие, например при выдаче аппарата другому человеку.
   */
  let extensionNote: string | undefined;
  if (typeof rest.sipExtension === "string") {
    const check = await checkManualExtension(rest.sipExtension, req.params.id);
    if (!check.ok) return res.status(409).json({ error: check.error });
    extensionNote = check.warning;
  }

  // Телефон — логин сотрудника и уникален в базе. Раньше занятый номер падал в
  // «Внутренняя ошибка», и директор не понимал, что не так (аудит 23.09.2026, №63).
  if (rest.phone) {
    const holder = await prisma.agent.findFirst({
      where: { phone: rest.phone, id: { not: req.params.id } },
      select: { fullName: true },
    });
    if (holder) return res.status(409).json({ error: `Этот телефон уже записан за сотрудником «${holder.fullName}»` });
  }

  // Отключение — переход «был активен → нет», а не повтор флага: лиды снимаем
  // только в первый раз (см. ниже).
  const wasActive =
    rest.isActive === false
      ? (await prisma.agent.findUnique({ where: { id: req.params.id }, select: { isActive: true } }))?.isActive === true
      : false;

  const data: Record<string, unknown> = { ...rest };
  // Смена роли сбрасывает личные надстройки прав (G9, 02.10.2026): галочки
  // выдавались поверх ПРЕЖНЕГО пресета, и понижённый до агента руководитель
  // продолжал видеть деньги и номера. Что снято — в журнал, чтобы директор мог
  // выдать заново осознанно.
  let resetOverrides: { granted: string[]; revoked: string[] } | null = null;
  if (rest.role !== undefined) {
    const before = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { role: true, permissions: true } });
    if (before && before.role !== rest.role && before.permissions !== null) {
      const old = parsePermissionOverrides(before.permissions);
      if (old.granted.length > 0 || old.revoked.length > 0) resetOverrides = old;
      data.permissions = Prisma.DbNull;
    }
  }

  const agent = await prisma.agent.update({ where: { id: req.params.id }, data });
  if (resetOverrides) {
    logAudit(req, "AGENT_PERMISSIONS_RESET_ON_ROLE_CHANGE", "Agent", agent.id, {
      targetAgentName: agent.fullName,
      role: agent.role,
      granted: resetOverrides.granted,
      revoked: resetOverrides.revoked,
    });
  }
  // Роль и статус входят в расчёт прав и кэшируются на 15 секунд — сбрасываем сразу,
  // иначе понижение в должности или отключение учётки подействует с задержкой.
  invalidateAgentAccess(agent.id);
  // Живой поток помнит роль и права на момент открытия (находка №148): при смене
  // роли или отключении рвём его — вкладка переподключится уже с новыми
  // правами, а у отключённого поток не откроется вовсе.
  if (rest.role !== undefined || rest.isActive === false) {
    closeStreamsForAgent(agent.id);
  }
  // Отключение учётки обязано убить и сессии устройств: иначе старый refresh-токен
  // жил ещё месяц и при обратной активации поднимал ту же сессию, а на телефон
  // уволенного продолжали приходить уведомления с телефонами клиентов.
  const deactivation = rest.isActive === false ? await finishAccountDeactivation(req, agent, wasActive) : null;
  // Активность или внутренний номер сменились — очередь входящих обязана узнать
  // об этом сама, без ручной правки станции (владелец 19.08.2026).
  if (rest.isActive !== undefined || rest.sipExtension !== undefined) {
    void syncAgentQueuePresence(agent.id).catch(() => {});
  }
  // Смена внутреннего номера или мобильного — повод перепроверить и мобильное
  // плечо: старый номер в DEVICE/dial мог остаться от прежнего телефона.
  if (rest.sipExtension !== undefined || rest.phone !== undefined) {
    void syncAgentMobileFallback(agent.id).catch(() => {});
  }
  // Номер сменился (или вписан руками) — включаем запись сразу же тем же
  // приёмом, что и при автовыдаче выше: правка карточки не должна оставлять
  // сотрудника без записи разговоров до ближайшего тика сторожа. Смотрим именно
  // на то, что пришло В ЭТОЙ правке (rest.sipExtension), а не просто «номер есть
  // сейчас» — иначе AMI дёргался бы на КАЖДОЙ правке карточки, включая те, что
  // номера не касаются вовсе.
  if (typeof rest.sipExtension === "string") {
    void ensureExtensionRecording(rest.sipExtension).catch(() => {});
  }
  // Назначили или сняли оператора — состав очереди приводим в порядок СРАЗУ, а не
  // ждём обхода (владелец 20.09.2026). Четверть часа, в которые снятый человек
  // продолжает получать незнакомые звонки, — ровно то, что запрещено; в обратную
  // сторону ожидание столь же бессмысленно: назначили оператора, чтобы он отвечал.
  if (rest.takesUnknownCalls !== undefined) {
    void ensureAgentsInIncomingQueue().catch(() => {});
    // И мобильное плечо: очередь звонит на внутренний номер оператора, а без
    // плеча внутренний номер — это тишина (20.09.2026, владелец назначил себя
    // первой линией, пуш пришёл, телефон не зазвонил). Ждать обхода нельзя:
    // пятнадцать минут тишины после включения — это пятнадцать минут потерянных
    // звонков.
    void syncAgentMobileFallback(req.params.id).catch(() => {});
  }
  logAudit(req, "AGENT_UPDATE", "Agent", agent.id, {
    fields: Object.keys(rest),
    // Выходные меняют раздачу лидов и штрафы агента — какие дни поставили, видно в журнале.
    ...(rest.weeklyDaysOff !== undefined ? { weeklyDaysOff: rest.weeklyDaysOff } : {}),
  });
  res.json({
    id: agent.id,
    fullName: agent.fullName,
    phone: agent.phone,
    role: agent.role,
    isActive: agent.isActive,
    kpi: agent.kpi,
    sipExtension: agent.sipExtension,
    // Смена языка подсказки не требует ничего делать руками: фоновая озвучка
    // (lib/telephony/whisperSync.ts) сама переозвучит клиентов этого агента и уберёт
    // файлы на прежнем языке — они выпадут из списка нужных при ближайшем проходе.
    whisperLanguage: agent.whisperLanguage,
    takesUnknownCalls: agent.takesUnknownCalls,
    sharePostTelegram: agent.sharePostTelegram,
    weeklyDaysOff: agent.weeklyDaysOff,
    // «Сохранили, но проверить номер на АТС не смогли» — предупреждение, а не отказ.
    extensionNote,
    ...(deactivation ?? {}),
  });
});

/**
 * Всё, что обязано случиться СРАЗУ после `isActive = false`, — в одном месте
 * для трёх входов: PATCH «отключить», «Передать дела» с галочкой «отключить
 * учётку» (24.09.2026) и удаление, упёршееся в историю. Сессии и подтверждение
 * личности гаснут, подписки устройств стираются (сессии гасли, а пуши с
 * данными клиентов ещё шли), непринятые лиды и предложения реактивации
 * снимаются — но только при переходе «был активен → нет», не при повторе флага.
 */
async function finishAccountDeactivation(
  req: Request,
  agent: { id: string; fullName: string },
  wasActive: boolean
): Promise<{ releasedLeads: number; clientsLeft: number } | null> {
  invalidateAgentAccess(agent.id);
  await revokeOtherSessions(agent.id);
  revokeElevation(agent.id);
  closeStreamsForAgent(agent.id);
  await prisma.pushSubscription.deleteMany({ where: { agentId: agent.id } });
  // Настройка не должна молча указывать на уволенного (ночная проверка
  // 24.09.2026, М12-в) — снимаем его из дежурного оператора/монтажёра/дежурных
  // по входящим, если он там стоял. Best-effort, как и остальное здесь: отказ
  // страховочной уборки не должен блокировать само отключение учётки.
  if (wasActive) {
    await clearAgentFromSettingsReferences(prisma, agent.id, agent.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие уволенного ${agent.fullName} из Настроек не выполнено:`, err)
    );
  }
  return wasActive ? await releaseWorkOfDeactivatedAgent(req, agent) : null;
}

/**
 * ОТКЛЮЧЕНИЕ УЧЁТКИ НЕ БРОСАЕТ ЛИДЫ (23.09.2026, проверка раздачи, пункт 16).
 *
 * Заморозка и удаление сотрудника разбирали его работу, а отключение — нет:
 * непринятые лиды оставались на учётке, в которую никто не войдёт, круг «не
 * принял» каждые 15 минут писал ей минус, а предложения вернуть клиента
 * висели до срока. Теперь непринятые лиды уходят в очередь тем же правилом,
 * что при заморозке, предложения снимаются. Клиентов в работе отключение
 * по-прежнему не трогает (см. «Передача дел» выше: отключить иногда нужно
 * срочно и без разбора портфеля), но руководитель получает пуш, сколько их
 * осталось, — иначе о них не узнаёт никто.
 */
async function releaseWorkOfDeactivatedAgent(
  req: Request,
  agent: { id: string; fullName: string }
): Promise<{ releasedLeads: number; clientsLeft: number }> {
  const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
  const actorName = actor?.fullName ?? "Неизвестно";
  const candidates = await findUnacceptedLeadsOfAgent(agent.id, "Отключение");
  // Снятыми считаются только реально снятые: принятого или переданного за время чтения
  // списка releaseLeadsToQueue пропускает (CRM-03).
  let leads: ReleasableLead[] = [];
  if (candidates.length > 0) {
    await prisma.$transaction(async (tx) => {
      leads = await releaseLeadsToQueue(tx, candidates, {
        agentId: agent.id,
        actorId: req.agent!.id,
        actorName,
        reason: `Учётка агента отключена руководителем ${actorName} — лид возвращён в очередь`,
        source: "deactivate",
      });
    });
  }
  await releaseReactivationOffersOfAgent(agent.id, req.agent!.id).catch((err) =>
    console.error(`[reactivation] предложения отключённого агента ${agent.fullName} не сняты:`, err)
  );
  const clientsLeft = await prisma.client.count({
    where: {
      assignedAgentId: agent.id,
      deletedAt: null,
      acceptedAt: { not: null },
      status: { notIn: ["LOST", "DEAL_CLOSED", "ARCHIVED"] },
    },
  });
  logAudit(req, "AGENT_DEACTIVATE_RELEASE", "Agent", agent.id, { releasedLeads: leads.length, clientsLeft });

  if (leads.length > 0 || clientsLeft > 0) {
    const directors = await prisma.agent.findMany({
      where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
      select: { id: true },
    });
    const parts = [
      leads.length > 0 ? `непринятых лидов возвращено в очередь: ${leads.length}` : null,
      clientsLeft > 0 ? `клиентов в работе осталось за ним: ${clientsLeft}, передайте дела` : null,
    ].filter(Boolean);
    await sendPushToAgents(
      directors.map((d) => d.id),
      {
        title: `Сотрудник отключён: ${agent.fullName}`,
        body: parts.join("; "),
        // Карточка отключённого сотрудника — там «Передать дела». Экрана
        // `/agents` в приложении нет: пуш открывал пустую страницу.
        url: `/team/${agent.id}`,
        tag: `agent-deactivate-${agent.id}`,
      }
    ).catch((err) => console.error("[agents] пуш руководству об отключении не отправлен:", err));
  }
  return { releasedLeads: leads.length, clientsLeft };
}

/**
 * Передача дел уходящего сотрудника: активные клиенты и незакрытые задачи по ним
 * уходят выбранному агенту или расходятся по команде обычным распределением.
 *
 * Отдельным действием, а не побочным эффектом отключения учётки: увольнение бывает
 * не единственной причиной (декрет, длинный отпуск, смена роли), а отключить учётку
 * иногда нужно срочно и без разбора портфеля. Требует подтверждения личности —
 * действие массовое и необратимое одним кликом.
 */
agentsRouter.post("/:id/handover", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const parsed = agentHandoverSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  // Учётка директора защищена от админа во ВСЕХ мутациях (PATCH, DELETE, аватар,
  // смена роли) — но передача дел эту проверку обходила: админ мог одним запросом
  // увести всех клиентов и объекты директора другому сотруднику, хотя саму учётку
  // тронуть не имел права. Найдено аудитом 06.08.2026.
  if (await forbiddenDirectorTarget(req, req.params.id)) {
    return res.status(403).json({ error: "Учётку директора может менять только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, req.params.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }
  const from = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, fullName: true } });
  if (!from) return res.status(404).json({ error: "Сотрудник не найден" });

  const { toAgentId, deactivate } = parsed.data;
  if (toAgentId === from.id) {
    return res.status(400).json({ error: "Нельзя передать дела тому же сотруднику" });
  }
  if (toAgentId) {
    const to = await prisma.agent.findUnique({ where: { id: toAgentId }, select: { isActive: true, frozenAt: true, fullName: true } });
    if (!to) return res.status(404).json({ error: "Получатель не найден" });
    if (!to.isActive) return res.status(409).json({ error: "Получатель отключён — выберите активного сотрудника" });
    // Замороженному (отпуск, больничный) дела не передаются (B13, решение владельца
    // 02.10.2026): клиенты висели бы у того, кто их сейчас не увидит.
    if (to.frozenAt) {
      return res.status(409).json({
        error: `${to.fullName} сейчас заморожен(а) (отпуск, больничный) — передать дела можно, когда заморозку снимут. Выберите другого сотрудника.`,
      });
    }
  }
  // Отказы отключения — ДО раздачи: передать дела и потом ответить «отключить
  // нельзя» значило бы оставить руководителя с полупроделанной работой.
  if (deactivate) {
    if (from.id === req.agent!.id) {
      return res.status(400).json({ error: "Свою учётку отключить нельзя — попросите другого руководителя" });
    }
    if (await wouldLoseLastDirector(from.id, { isActive: false })) {
      return res.status(409).json({ error: "В системе должен остаться хотя бы один активный директор" });
    }
  }

  const result = await handoverAgentWork(from.id, toAgentId, req.agent!.id);
  logAudit(req, "AGENT_HANDOVER", "Agent", from.id, {
    toAgentId: toAgentId ?? null,
    clients: result.clients,
    tasks: result.tasks,
    properties: result.properties,
    unassigned: result.unassigned,
    deactivate: Boolean(deactivate),
  });

  /**
   * ОТКЛЮЧЕНИЕ СРАЗУ ПОСЛЕ ПЕРЕДАЧИ (владелец 24.09.2026: «после передачи
   * клиентов деактивируем аккаунт»). Раньше это были два отдельных действия в
   * разных окнах, и второе забывалось: уволенный ещё день-два мог войти, а его
   * учётка оставалась в очереди звонков. Шаги те же, что у PATCH isActive=false
   * (finishAccountDeactivation), поэтому ничего не расходится.
   */
  let deactivated = false;
  if (deactivate) {
    const before = await prisma.agent.findUnique({ where: { id: from.id }, select: { isActive: true } });
    const agent = await prisma.agent.update({ where: { id: from.id }, data: { isActive: false } });
    await finishAccountDeactivation(req, agent, before?.isActive === true);
    void syncAgentQueuePresence(agent.id).catch(() => {});
    logAudit(req, "AGENT_UPDATE", "Agent", agent.id, { fields: ["isActive"], afterHandover: true });
    deactivated = true;
    // Снимок раздачи знает, что учётку отключили тем же нажатием, — возврат включит её обратно.
    if (result.batchId) {
      await prisma.agentHandoverBatch.update({ where: { id: result.batchId }, data: { deactivated: true } });
    }
  }
  res.json({ ...result, deactivated });
});

/**
 * Прошлые передачи дел сотрудника — для кнопки «Вернуть всё как было» в его
 * карточке (владелец 24.09.2026). Последние пять, новые первыми; по каждой —
 * что ушло и возвращена ли уже.
 */
agentsRouter.get("/:id/handovers", requirePermission("agents.manage"), async (req, res) => {
  const rows = await prisma.agentHandoverBatch.findMany({
    where: { fromAgentId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      createdAt: true,
      clients: true,
      tasks: true,
      properties: true,
      deactivated: true,
      toAgentId: true,
      revertedAt: true,
      revertSummary: true,
    },
  });
  res.json(rows);
});

/**
 * ВЕРНУТЬ ВСЁ КАК БЫЛО (владелец 24.09.2026: «верни всех клиентов и объекты
 * Сурайё на место, она вернулась на работу, и добавь такую же кнопку для
 * возврата… даже после деактивации»). Идёт по снимку раздачи
 * (lib/agentHandoverRevert.ts): клиенты, задачи и объекты, что всё ещё у
 * получателей, возвращаются прежнему агенту принятыми; учётка, отключённая тем
 * же нажатием, включается. Массовое действие — с подтверждением личности.
 */
agentsRouter.post("/handovers/:batchId/revert", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const batch = await prisma.agentHandoverBatch.findUnique({
    where: { id: req.params.batchId },
    select: { id: true, fromAgentId: true, revertedAt: true, deactivated: true },
  });
  if (!batch) return res.status(404).json({ error: "Передача дел не найдена" });
  if (batch.revertedAt) return res.status(409).json({ error: "Эта передача дел уже возвращена" });
  if (await forbiddenDirectorTarget(req, batch.fromAgentId)) {
    return res.status(403).json({ error: "Учётку директора может менять только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, batch.fromAgentId)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }

  const outcome = await revertAgentHandover(batch.id, req.agent!.id);
  if (!outcome.ok) {
    return res
      .status(outcome.reason === "not_found" ? 404 : 409)
      .json({ error: outcome.reason === "not_found" ? "Передача дел не найдена" : "Эта передача дел уже возвращена" });
  }
  if (outcome.result.reactivated) {
    // Права и очередь входящих обязаны узнать, что человек снова в строю, — те же
    // хвосты, что у PATCH isActive=true.
    invalidateAgentAccess(batch.fromAgentId);
    void syncAgentQueuePresence(batch.fromAgentId).catch(() => {});
  }
  logAudit(req, "AGENT_HANDOVER_REVERT", "Agent", batch.fromAgentId, { batchId: batch.id, ...outcome.result });
  res.json(outcome.result);
});

/** Разбор KPI агента: из чего сложился итоговый процент. Последние 14 дневных
 * снапшотов (KpiDailyScore.breakdown) — по каждой метрике набрано/максимум;
 * отсутствующая в breakdown метрика в тот день была недоступна агенту и не
 * участвовала в расчёте (принцип честного KPI из ТЗ). */
agentsRouter.get("/:id/kpi", requirePermission("team.viewFull"), async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, kpi: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  const days = await prisma.kpiDailyScore.findMany({
    where: { agentId: agent.id },
    orderBy: { date: "desc" },
    take: 14,
    select: { date: true, score: true, breakdown: true },
  });
  res.json({ ...agent, days });
});

/** Аварийный сброс 2FA сотрудника (потерян телефон): только директор, со свежим
 * step-up подтверждением. Сотрудник после этого входит по паролю и настраивает
 * 2FA заново. Действие пишется в журнал. */
/**
 * Позвонить коллеге. Внутренние звонки АТС умеет и без CRM — достаточно набрать
 * номер на софтфоне, — но помнить, что Наргиза это 1008, никто не обязан. Кнопка
 * в разделе «Команда» звонит по имени: сначала звонит трубка того, кто звонит,
 * потом АТС соединяет с коллегой.
 *
 * Отдельного права нет намеренно: список коллег и так виден всем сотрудникам, а
 * звонок внутри офиса — не более чувствительное действие, чем подойти к столу.
 */
agentsRouter.post("/:id/call", async (req, res) => {
  const [me, target] = await Promise.all([
    prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { sipExtension: true, phone: true } }),
    prisma.agent.findUnique({
      where: { id: req.params.id },
      select: { sipExtension: true, fullName: true, isActive: true, phone: true },
    }),
  ]);
  if (!target) return res.status(404).json({ error: "Сотрудник не найден" });
  /**
   * УВОЛЕННОМУ НЕ ЗВОНИМ. Признак `isActive` уже читался, но ни на что не влиял, и
   * кнопка «позвонить» рядом с бывшим сотрудником работала как ни в чём не бывало.
   *
   * Это не косметика: в базе живут учётки с выдуманными телефонами из тестовых
   * данных (`+992777776010` и подобные), станция честно их набирает, а оператор
   * связи ОТВЕЧАЕТ автоинформатором «номер не существует» — в журнале станции это
   * `ANSWERED`, то есть для CRM состоявшийся разговор: запись, платная расшифровка
   * и строка в хронологии. Один такой «разговор 1:19» уже лежит в проде.
   */
  if (!target.isActive) {
    return res.status(409).json({ error: `${target.fullName} больше не работает — звонок невозможен` });
  }
  if (!me?.sipExtension) {
    return res.status(409).json({ error: "У вас не настроен внутренний номер — обратитесь к директору" });
  }
  if (!target.sipExtension) {
    return res.status(409).json({ error: `У сотрудника ${target.fullName} нет внутреннего номера` });
  }
  // Тот же круг доступа, что у «Позвонить» из карточки клиента: нельзя начать
  // второй звонок, не закончив первый (найдено ревью 19.08.2026 — раньше этой
  // проверки здесь не было вовсе, звонок коллеге не регистрировался в `calls`
  // и мог задвоиться простым повторным нажатием).
  if (hasLiveCall(req.agent!.id)) {
    return res.status(409).json({ error: "У вас уже идёт звонок — завершите его, прежде чем начать новый" });
  }
  if (!beginOrigination(req.agent!.id)) {
    return res.status(409).json({ error: "У вас уже идёт звонок — завершите его, прежде чем начать новый" });
  }

  try {
  const creds = await loadAriCredentials();
  if (!creds) return res.status(409).json({ error: "Телефония не настроена — нет ключей ARI в Настройках" });

  /**
   * ОБЕ СТОРОНЫ ЗВОНКА ИДУТ ТЕМ ЖЕ ПУТЁМ, ЧТО И ЗВОНОК КЛИЕНТУ (владелец 16.08.2026:
   * «чтобы все всегда были в сети»).
   *
   * Раньше запасной мобильный подставлялся только звонящему и только в жёстком
   * режиме "mobile". В режиме "auto" (он и стоит на проде) сравнение
   * `dialMode === "mobile"` давало false, и оба плеча уходили на внутренние номера:
   * коллега без связи — закрыт браузер, кончился интернет, выключен софтфон — просто
   * не получал звонка, а звонящий видел бесконечные гудки. Для КОЛЛЕГИ мобильного
   * не подставлялось вовсе ни в каком режиме.
   *
   * Теперь для каждой стороны спрашивается `resolveAgentDialTarget` — тот же
   * механизм, что у кнопки «Позвонить» в карточке клиента и у перевода входящего:
   * трубка на связи (софтфон или браузер CRM) — звоним на внутренний, не на связи —
   * на мобильный.
   */
  const dialMode = await loadAgentDialMode();
  const [caller, colleague] = await Promise.all([
    // Звонящему — как настроено в CRM: это его собственная трубка, и режим для неё
    // владелец выбирает осознанно.
    resolveAgentDialTarget(creds, me.sipExtension, me.phone, dialMode),
    /**
     * Коллеге — ВСЕГДА «авто», независимо от режима. Мобильный здесь именно
     * ЗАПАСНОЙ путь: жёсткий режим "mobile" гнал бы на сотовый каждый внутренний
     * звонок, в том числе когда коллега сидит в CRM с работающей трубкой. Это
     * платное плечо через транк вместо бесплатного внутреннего — и ровно
     * противоположное тому, ради чего запасной путь заводился («дозвониться, когда
     * человека нет в сети», владелец 16.08.2026).
     */
    resolveAgentDialTarget(creds, target.sipExtension, target.phone, "auto"),
  ]);
  // Куда набирать коллегу: его мобильный, если трубки нет на связи, иначе внутренний.
  const colleagueTarget = colleague.agentMobile ?? target.sipExtension;
  const result = await originateCall(creds, me.sipExtension, colleagueTarget, {
    callerName: target.fullName,
    agentMobile: caller.agentMobile,
  });
  if (!result.ok) return res.status(502).json({ error: result.error ?? "Не удалось позвонить" });
  res.json({ ok: true, channelId: result.channelId, extension: target.sipExtension });
  } finally {
    endOrigination(req.agent!.id);
  }
});

agentsRouter.post("/:id/2fa/reset", requirePermission("agents.reset2fa"), requireElevation, async (req, res) => {
  // Учётка директора защищена от админа во всех мутациях (PATCH, DELETE, аватар,
  // передача дел) — а сброс второго фактора эту проверку обходил: `agents.reset2fa`
  // лежит в пресете ADMIN, и админ мог снять 2FA с владельца. Ночная проверка 24.09.2026.
  if (await forbiddenDirectorTarget(req, req.params.id)) {
    return res.status(403).json({ error: "Управлять учёткой директора может только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, req.params.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }
  const target = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, fullName: true } });
  if (!target) return res.status(404).json({ error: "Сотрудник не найден" });
  await prisma.agent.update({ where: { id: target.id }, data: { totpEnabled: false, totpSecret: null } });
  // Как при смене пароля/отключении учётки (PATCH выше): снятый второй фактор —
  // повод перезайти. Иначе сессии, открытые ещё под старым 2FA, жили бы дальше,
  // и сброс ничего не менял для того, кто уже внутри.
  await revokeOtherSessions(target.id);
  revokeElevation(target.id);
  closeStreamsForAgent(target.id);
  logAudit(req, "TOTP_RESET_BY_DIRECTOR", "Agent", target.id, { targetName: target.fullName });
  res.json({ totpEnabled: false });
});

agentsRouter.post("/:id/avatar", requirePermission("agents.manage"), requireElevation, anyParams(upload.single("avatar")), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });
  if (await forbiddenDirectorTarget(req, req.params.id)) {
    return res.status(403).json({ error: "Управлять учёткой директора может только директор" });
  }
  // Сначала — есть ли такой сотрудник: иначе файл ложился на диск, update падал
  // P2025 → 500 и файл-сирота (G18, 02.10.2026).
  const before = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { avatarUrl: true } });
  if (!before) return res.status(404).json({ error: "Сотрудник не найден" });

  const avatarUrl = await saveAgentAvatarFile(req.params.id, req.file.buffer);
  const agent = await prisma.agent.update({
    where: { id: req.params.id },
    data: { avatarUrl },
    select: { id: true, fullName: true, phone: true, role: true, isActive: true, avatarUrl: true },
  });
  await removeAgentAvatarFile(agent.id, before.avatarUrl);
  res.json(agent);
});

/** Сколько записей истории начислений уходит в интерфейс за один запрос. */
const POINTS_HISTORY_LIMIT = 500;

/** История начислений баллов ДО запрета ручной правки счёта (спецификация 03.08.2026,
 * Fair Play: «Ручное изменение KPI запрещено. Ни агент. Ни руководитель. Ни
 * администратор»). Начислять больше нельзя — POST-маршрут снят вместе с правом
 * `agents.points`; читаем только для истории, записи не удаляются задним числом. */
agentsRouter.get("/:id/points", requirePermission("team.viewFull"), async (req, res) => {
  const [entries, totals] = await Promise.all([
    prisma.auditLog.findMany({
      where: { action: "POINTS_AWARD", entityType: "Agent", entityId: req.params.id },
      orderBy: { createdAt: "desc" },
      // Предел выборки — правило репозитория для любого маршрута, отдающего массив.
      // Итог берётся отдельно, из SUM в базе, поэтому обрезанная история его не
      // искажает: у экрана «последние N начислений», а не «столько всего было».
      take: POINTS_HISTORY_LIMIT,
    }),
    sumPointsByAgent([req.params.id]),
  ]);
  res.json({ total: totals.get(req.params.id) ?? 0, entries });
});

agentsRouter.delete("/:id", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  if (req.params.id === req.agent!.id) {
    return res.status(400).json({ error: "Нельзя удалить собственную учётную запись" });
  }
  if (await forbiddenDirectorTarget(req, req.params.id)) {
    return res.status(403).json({ error: "Управлять учёткой директора может только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, req.params.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }

  /**
   * СНАЧАЛА РАЗДАЁМ КЛИЕНТОВ, ПОТОМ УДАЛЯЕМ.
   *
   * Требование владельца 10.08.2026: «при удалении агента чтобы его клиенты
   * распределились по агентам KPI». Раньше удаление такого агента просто не
   * проходило — база не давала (внешний ключ), и маршрут отвечал «деактивируйте
   * вместо удаления». Клиенты при этом оставались висеть на человеке, которого в
   * компании больше нет: лиды без ответа, задачи без исполнителя.
   *
   * Раздача — тем же механизмом, что и «Передача дел» (lib/agentHandover.ts): без
   * указания получателя он разносит портфель по очереди KPI. Очередь при этом одна
   * на всю CRM, второй заводить нельзя — это решение владельца о справедливости.
   * Разное у клиентов и объектов только НАПРАВЛЕНИЕ (решение владельца 11.08.2026):
   * клиенты идут агентам с высоким Royal Score, горячие первыми, объекты — с низким.
   * Почему так — объяснено в lib/agentHandover.ts.
   *
   * Раздача происходит ДО удаления и не откатывается, если удаление потом упрётся
   * в объекты или сделки: клиенты у живых агентов — состояние в любом случае
   * лучшее, чем клиенты у уволенного, и ответ ниже об этом честно скажет.
   */
  const handover = await handoverAgentWork(req.params.id, undefined, req.agent!.id);

  // Разведка 07.09.2026 (класс «осиротевшие спутники»): ДО удаления, как и сама
  // раздача выше — уходящий решать по предложениям реактивации уже не может.
  // При жёстком удалении onDelete:SetNull и так очистил бы поле, но при отказе
  // (P2003 ниже, «деактивируем вместо удаления») строка агента остаётся, и без
  // этого вызова предложение осталось бы висеть на отключённой учётке навсегда.
  await releaseReactivationOffersOfAgent(req.params.id, req.agent!.id).catch((err) =>
    console.error(`[reactivation] предложения уволенного агента ${req.params.id} не сняты:`, err)
  );

  // Журнал, который каскад унёс бы вместе со строкой (входы, Royal Score, KPI,
  // заявки, споры), стирать нельзя — идём той же веткой, что и при сделках
  // (находка №195, lib/agentHistory.ts).
  if (await agentHasCascadeHistory(req.params.id)) {
    return disableInsteadOfDelete(req, res, req.params.id, handover, "has history");
  }

  try {
    const deleted = await prisma.agent.delete({ where: { id: req.params.id } });
    invalidateAgentAccess(deleted.id);
    closeStreamsForAgent(deleted.id);
    // Поля Настроек хранят id строкой, без внешнего ключа: стёртый сотрудник
    // остался бы монтажёром/дежурным навсегда (G4, 02.10.2026).
    await clearAgentFromSettingsReferences(prisma, deleted.id, deleted.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие удалённого ${deleted.fullName} из Настроек не выполнено:`, err)
    );
    logAudit(req, "DELETE", "Agent", deleted.id, {
      fullName: deleted.fullName,
      role: deleted.role,
      handoverClients: handover.clients,
      handoverProperties: handover.properties,
    });
    // 200 с отчётом, а не пустой 204: руководитель должен видеть, кому ушли клиенты,
    // — иначе раздача выглядит как пропажа.
    res.json({ ok: true, handover });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return res.status(404).json({ error: "Агент не найден" });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      /**
       * ПОЛНОГО СТИРАНИЯ СТРОКИ БЫТЬ НЕ МОЖЕТ — И НЕ ДОЛЖНО.
       *
       * Клиенты и объекты к этому моменту уже разошлись по агентам (см. выше) — значит
       * держат сделки, принятые объекты или историю. Их переписывать НА ДРУГОГО АГЕНТА
       * нельзя: Deal.commissionRealtorAmount/commissionIntakeAmount — снапшот, кто
       * реально заработал комиссию на закрытой сделке, а история звонков/загрузок
       * фиксирует, кто что делал. Молча переставить agentId значило бы соврать
       * финансовой отчётности и задним числом переписать, кому заплатили.
       *
       * Вместо этого (18.08.2026, владелец: «добавь возможность удаления сотрудника
       * полностью, всё остальное распределяется по КПИ автоматически») — учётку
       * отключаем И ОСВОБОЖДАЕМ ЕЁ ТЕЛЕФОН (переносим в phone с меткой), чтобы им
       * сразу мог зарегистрироваться новый человек. Для владельца это и есть «удалил»:
       * сотрудника больше нет в списках, войти он не может, номер свободен — история
       * при этом осталась целой и правдивой на месте старой (теперь скрытой) записи.
       */
      return disableInsteadOfDelete(req, res, req.params.id, handover, "has deals/properties/history");
    }
    throw err;
  }
});

/**
 * «Удалить» вместо стирания: учётка отключается, телефон освобождается, история
 * остаётся. Сюда ведут две дороги: база отказала в стирании (сделки, объекты,
 * звонки — P2003) и проверка заранее нашла записи, которые каскад унёс бы молча
 * (журнал входов, Royal Score, KPI и т.п. — lib/agentHistory.ts, находка №195).
 */
async function disableInsteadOfDelete(
  req: Request,
  res: Response,
  agentId: string,
  handover: { clients: number; properties: number },
  reason: string
) {
  const current = await prisma.agent.findUnique({ where: { id: agentId }, select: { phone: true, isActive: true } });
  // Повторное «удалить» (двойное нажатие) не наслаивает метку второй раз.
  const freedPhone = current?.phone.startsWith(`${agentId}-deleted:`)
    ? current.phone
    : `${agentId}-deleted:${current?.phone}`;
  // Telegram отвязываем: учётки «нет», а привязанный чат продолжал бы получать
  // то, что шлётся по id (ролики монтажёру), и не дал бы привязать тот же чат к
  // новой учётке при повторном найме — telegramChatId уникален (G4/G16, 02.10.2026).
  const deactivated = await prisma.agent.update({
    where: { id: agentId },
    data: { isActive: false, phone: freedPhone, telegramChatId: null },
  });
  invalidateAgentAccess(deactivated.id);
  await revokeOtherSessions(deactivated.id);
  revokeElevation(deactivated.id);
  closeStreamsForAgent(deactivated.id);
  // То же, что при отключении тумблером (finishAccountDeactivation), кроме
  // разбора лидов — его здесь уже сделала раздача выше: подписки устройств,
  // поля Настроек, очередь входящих (G4, 02.10.2026).
  await prisma.pushSubscription.deleteMany({ where: { agentId } });
  if (current?.isActive) {
    await clearAgentFromSettingsReferences(prisma, agentId, deactivated.fullName, "deactivate").catch((err) =>
      console.error(`[agents] снятие удалённого ${deactivated.fullName} из Настроек не выполнено:`, err)
    );
  }
  void syncAgentQueuePresence(agentId).catch(() => {});
  logAudit(req, "UPDATE", "Agent", deactivated.id, {
    fullName: deactivated.fullName,
    deactivatedInsteadOfDeleted: true,
    reason,
    handoverClients: handover.clients,
    handoverProperties: handover.properties,
  });
  return res.json({
    ok: true,
    deactivatedInsteadOfDeleted: true,
    handover,
    message:
      `Клиенты и объекты переданы другим агентам (${handover.clients} клиентов, ${handover.properties} объектов). ` +
      "За сотрудником числятся сделки или история работы, поэтому строку целиком стереть нельзя — учётка отключена, " +
      "войти в неё больше нельзя, а телефон свободен для нового сотрудника.",
  });
}

/**
 * Персональные права сотрудника.
 *
 * РАЗДАВАТЬ ПРАВА МОЖЕТ И ДИРЕКТОР, И АДМИН (14.09.2026, решение владельца:
 * ADMIN во всём равен DIRECTOR — четыре бывших directorOnly-права, включая
 * это, стали обычными ASSIGNABLE_PERMISSIONS и попали в пресет ADMIN
 * автоматически). До этой правки permissions.manage было владельческим —
 * resolvePermissions вычёркивало его у всех, кроме директора; теперь это
 * обычная галочка, которую директор может снять с конкретного админа так же,
 * как любое другое право, если не хочет делегировать именно раздачу прав.
 */
agentsRouter.get("/:id/permissions", requirePermission("permissions.manage"), async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, role: true, permissions: true },
  });
  if (!agent) return res.status(404).json({ error: "Агент не найден" });

  const role = agent.role as Role;
  const overrides = parsePermissionOverrides(agent.permissions);
  res.json({
    agentId: agent.id,
    fullName: agent.fullName,
    role,
    roleSummary: ROLE_PRESET_SUMMARY[role],
    // Директор — владелец: у него всё включено и менять нечего.
    editable: role !== "DIRECTOR",
    overrides,
    items: describePermissions(role, overrides),
  });
});

agentsRouter.put("/:id/permissions", requirePermission("permissions.manage"), requireElevation, async (req, res) => {
  const parsed = permissionOverridesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }

  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, role: true },
  });
  if (!agent) return res.status(404).json({ error: "Агент не найден" });
  if (agent.role === "DIRECTOR") {
    return res.status(400).json({ error: "У директора всегда полный доступ — права не настраиваются" });
  }

  // Акционеру права не добавляются (10.10.2026): он смотрит, но не видит номера
  // клиентов и контакты собственников осознанно. Снимать (revoked) можно.
  if (agent.role === "SHAREHOLDER" && parsed.data.granted.length > 0) {
    return res.status(400).json({ error: "Акционеру права не добавляются" });
  }

  // normalizeOverrides выбрасывает владельческие права и противоречия ещё до записи:
  // даже если запрос собран руками в обход интерфейса, в базу ляжет чистый набор.
  const overrides = normalizeOverrides(agent.role as Role, parsed.data);
  const isEmpty = overrides.granted.length === 0 && overrides.revoked.length === 0;

  await prisma.agent.update({
    where: { id: agent.id },
    data: { permissions: isEmpty ? Prisma.DbNull : (overrides as unknown as Prisma.InputJsonObject) },
  });
  invalidateAgentAccess(agent.id);
  closeStreamsForAgent(agent.id);
  logAudit(req, "AGENT_PERMISSIONS_UPDATE", "Agent", agent.id, {
    targetAgentName: agent.fullName,
    role: agent.role,
    granted: overrides.granted,
    revoked: overrides.revoked,
  });

  res.json({
    agentId: agent.id,
    role: agent.role as Role,
    overrides,
    items: describePermissions(agent.role as Role, overrides),
  });
});

/**
 * ЭКСТРЕННАЯ ЗАМОРОЗКА сотрудника.
 *
 * Отличается от «отключить» (isActive=false) тем, что человек продолжает работать в
 * CRM: он видит своих клиентов, дописывает историю, закрывает начатое. Прекращается
 * ровно одно — выдача НОВОЙ работы. Это состояние для разбирательства и длинной
 * болезни, когда увольнять рано, а грузить нельзя.
 *
 * KPI замирает на последнем значении: замороженному не выдают лидов, и падение счёта
 * означало бы наказание за то, что ему запретили работать. Место в рейтинге при этом
 * сохраняется — по той же причине.
 *
 * Активные лиды освобождаются и уходят в общую очередь: держать их у человека,
 * который сегодня к ним не подойдёт, — это потерянные клиенты, а не порядок.
 */
agentsRouter.post("/:id/freeze", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const parsed = agentFreezeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, frozenAt: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  // Директора замораживает только директор: forbiddenPrivilegedTarget пропускает
  // любого с permissions.manage (пресет ADMIN), и без этой проверки админ со
  // step-up освобождал лиды директора (ACCESS-06).
  if (await forbiddenDirectorTarget(req, agent.id)) {
    return res.status(403).json({ error: "Учётку директора может менять только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, agent.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }
  if (agent.frozenAt) return res.status(409).json({ error: "Сотрудник уже заморожен" });
  if (agent.id === req.agent!.id) return res.status(400).json({ error: "Нельзя заморозить самого себя" });
  if (parsed.data.until && parsed.data.until.getTime() < Date.now()) {
    return res.status(400).json({ error: "Дата выхода уже прошла" });
  }

  // Освобождаем ТОЛЬКО непринятые и активные лиды (lib/agentLeadRelease.ts —
  // то же правило, что при отключении учётки). Список читаем ДО транзакции —
  // он же уходит в пуш руководителю ниже (аудит владения 11.09.2026, дыра №1:
  // каждый клиент проходит через changeClientAgent).
  // Лид по СВОЕМУ объекту заморозка не снимает (10.10.2026, аудит P0-5): отпуск не
  // отменяет владение (решение владельца 11.09.2026, services/leads/assignment.ts) —
  // раздача и так отдаёт такие лиды замороженному хозяину с пушем руководителю, и
  // снятие тут же уводило их по очереди к постороннему. Тот же щиток, что у паузы.
  const toRelease = await findUnacceptedLeadsOfAgent(agent.id, "Заморозка", { keepOwnProperty: true });

  const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });

  let releasedLeads: ReleasableLead[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        frozenAt: new Date(),
        frozenById: req.agent!.id,
        frozenReason: parsed.data.reason.trim(),
        frozenReasonVoiceUrl: parsed.data.reasonVoiceUrl ?? null,
        frozenReasonVoiceTranscript: parsed.data.reasonVoiceTranscript ?? null,
        /**
         * Вид и срок отсутствия (владелец 09.09.2026). Не заданы — значит это
         * прежняя экстренная заморозка «для разбирательства»: absenceKind остаётся
         * пустым и читается как OTHER, то есть по-больничному осторожно
         * (см. lib/agentAvailability.ts, absenceKindOf).
         *
         * Заданный срок снимет заморозку сам (lib/absenceReturn.ts) — забытый
         * отпуск иначе стоит молча: агент вышел, а лиды и входящие звонки к нему
         * не идут, и система об этом не жалуется.
         */
        absenceKind: parsed.data.kind ?? null,
        absenceUntil: parsed.data.until ?? null,
        // Пауза, если она была, теряет смысл: заморозка строже и снимается иначе.
        leadsPausedUntil: null,
        leadsPausedById: null,
        leadsPausedReason: null,
      },
    });

    // Настройка не должна молча указывать на замороженного (ночная проверка
    // 24.09.2026, М12-в) — снимаем его из дежурного оператора/монтажёра/
    // дежурных по входящим, если он там стоял.
    await clearAgentFromSettingsReferences(tx, agent.id, agent.fullName, "freeze");

    // actorName передан явно (22.09.2026, сведение N+1): тот же руководитель
    // на каждой карточке, без него changeClientAgent читала бы имя заново.
    releasedLeads = await releaseLeadsToQueue(tx, toRelease, {
      agentId: agent.id,
      actorId: req.agent!.id,
      actorName: actor?.fullName ?? "Неизвестно",
      reason: `Агент заморожен руководителем ${actor?.fullName ?? req.agent!.id}: «${parsed.data.reason.trim()}» — лид возвращён в очередь`,
      source: "freeze",
    });
  });
  const released = { count: releasedLeads.length };

  closeStreamsForAgent(agent.id);
  logAudit(req, "AGENT_FREEZE", "Agent", agent.id, { reason: parsed.data.reason, released: released.count });

  if (releasedLeads.length > 0) {
    const directors = await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } });
    const names = releasedLeads.slice(0, 5).map((c) => c.fullName).join(", ");
    const more = releasedLeads.length > 5 ? ` и ещё ${releasedLeads.length - 5}` : "";
    // Один запрос на всех директоров разом (были sendPushToAgent(d.id, ...) на
    // каждого — N+1 на подписки/тихие часы при росте числа директоров), 22.09.2026.
    await sendPushToAgents(
      directors.map((d) => d.id),
      {
        title: "Заморозка агента: лиды в очереди",
        body: `${agent.fullName}: ${releasedLeads.length} лид(ов) снято и возвращено в очередь — ${names}${more}`,
        url: "/team",
        tag: `agent-freeze-${agent.id}`,
      }
    ).catch((err) => console.error("[agents] пуш руководству о заморозке не отправлен:", err));
  }

  /**
   * ТРЕБОВАНИЯ (PendingSummary) ПРИ ЗАМОРОЗКЕ НЕ ГАСЯТСЯ — И ЭТО НЕ ЗАБЫТО, А
   * НЕ РЕШЕНО (22.09.2026).
   *
   * Здесь стоял пустой цикл `for (const c of frozenClients) {}` над выборкой
   * всех клиентов агента: след неудачной правки по аудиту 02.09.2026 (§7 шаг 6).
   * Выборка выполнялась на каждую заморозку и никуда не шла, а абзац про
   * реактивацию ниже был скопирован дважды. Мёртвый код убран.
   *
   * Сам шаг не восстановлен нарочно, потому что его же обоснование больше не
   * сходится с кодом: обещанного блокирования выдачи лидов в `selection.ts` нет
   * (PendingSummary там не упоминается вовсе), а `lib/pendingSummaries.ts` с
   * `dismissSummary`, на который ссылается схема, в репозитории отсутствует.
   * Чем гасить — `doneAt` («итог записан») или `dismissedAt` («закрыто без
   * заполнения») — это разные вещи для отчётов и Royal Score, и выбор за
   * владельцем, а не за догадкой. Записано в docs/TASKS.md.
   */

  // Разведка 07.09.2026 (класс «осиротевшие спутники»): «Предложение реактивации»
  // тоже держится за конкретного агента — замороженный решать по нему не может,
  // а без этой строки предложение осталось бы висеть на нём до TTL-крона.
  await releaseReactivationOffersOfAgent(agent.id, req.agent!.id).catch((err) =>
    console.error(`[reactivation] предложения замороженного агента ${agent.fullName} не сняты:`, err)
  );

  void syncAgentQueuePresence(agent.id).catch(() => {});
  res.json({ ok: true, released: released.count });
});

/**
 * ПАУЗА ПРИЁМА ЛИДОВ ОТ РУКОВОДИТЕЛЯ (24.09.2026, владелец: «админу и директору
 * тоже кнопку внутри профиля работников… чтобы отдохнуть в тот день»).
 *
 * Та же пауза, что агент включает себе сам в профиле (routes/me.ts), а НЕ
 * заморозка: человек на месте, текущие клиенты и звонки остаются у него, KPI
 * идёт. Отличия от своей паузы — ровно в том, чего требует решение руководителя:
 * нет потолка из Настроек и «остыть» (срок выбирает руководитель, до 30 суток
 * схемой), и снять её может только руководитель.
 *
 * Без подтверждения личности (requireElevation), в отличие от заморозки:
 * действие обратимо в один клик и не трогает ни учётку, ни KPI, а окно пароля на
 * каждое «дай человеку выходной» сделало бы кнопку тяжелее, чем она стоит.
 */
agentsRouter.post("/:id/lead-pause", requirePermission("agents.manage"), async (req, res) => {
  const parsed = supervisorLeadPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, role: true, isActive: true, frozenAt: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  if (agent.id === req.agent!.id) return res.status(400).json({ error: "Свою паузу включают в профиле" });
  // Лиды раздаются только агентам — пауза остальным ничего бы не изменила.
  if (!(SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return res.status(400).json({ error: "Лиды получают только агенты и руководитель продаж" });
  if (!agent.isActive) return res.status(409).json({ error: "Сотрудник отключён" });
  if (agent.frozenAt) return res.status(409).json({ error: "Сотрудник уже заморожен — лиды ему и так не идут" });

  const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
  const actorName = actor?.fullName ?? "Руководитель";
  // Своя пауза агента, если была, заменяется паузой руководителя с новым сроком.
  const until = new Date(Date.now() + parsed.data.hours * 3600_000);
  const reason = parsed.data.reason?.trim() || null;
  const { released } = await startLeadPause({
    agentId: agent.id,
    until,
    actor: { id: req.agent!.id, fullName: actorName },
    bySupervisor: true,
    reason,
  });
  logAudit(req, "AGENT_LEAD_PAUSE_BY_SUPERVISOR", "Agent", agent.id, {
    targetAgentName: agent.fullName,
    until: until.toISOString(),
    reason,
    released,
  });
  notifyAgentAboutSupervisorPause(agent.id, actorName, { until, reason });
  res.json({ ok: true, pausedUntil: until, released });
});

/** Руководитель снимает паузу — любую: и свою, и поставленную самим агентом. */
agentsRouter.delete("/:id/lead-pause", requirePermission("agents.manage"), async (req, res) => {
  const agent = await prisma.agent.findUnique({
    where: { id: req.params.id },
    select: { id: true, fullName: true, leadsPausedUntil: true, leadsPausedById: true, frozenAt: true },
  });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  if (!availabilityOf(agent).pausedUntil) return res.status(409).json({ error: "Пауза не включена" });

  await endLeadPause(agent);
  logAudit(req, "AGENT_LEAD_RESUME_BY_SUPERVISOR", "Agent", agent.id, { targetAgentName: agent.fullName });
  const actor = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { fullName: true } });
  notifyAgentAboutSupervisorPause(agent.id, actor?.fullName ?? "Руководитель", null);
  res.json({ ok: true });
});

/** Разморозка. Отдельным маршрутом, а не флагом в PATCH: это управленческое решение,
 *  и в журнале оно должно быть отдельной строкой, а не «изменены поля сотрудника». */
agentsRouter.post("/:id/unfreeze", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  const agent = await prisma.agent.findUnique({ where: { id: req.params.id }, select: { id: true, frozenAt: true } });
  if (!agent) return res.status(404).json({ error: "Сотрудник не найден" });
  // Те же две защиты, что и на заморозке: разморозка чужой учётки директора или
  // раздающего права — такая же правка учётки (ACCESS-06).
  if (await forbiddenDirectorTarget(req, agent.id)) {
    return res.status(403).json({ error: "Учётку директора может менять только директор" });
  }
  if (await forbiddenPrivilegedTarget(req, agent.id)) {
    return res.status(403).json({ error: PRIVILEGED_TARGET_ERROR });
  }
  if (!agent.frozenAt) return res.status(409).json({ error: "Сотрудник не заморожен" });

  // Разморозка и сдвиг часов светофора — одной транзакцией: без сдвига
  // вернувшийся агент на первом же тике терял неактивных клиентов пачкой
  // (см. shiftInactiveClockAfterAbsence), а сдвиг без разморозки сдвинул бы
  // часы у всё ещё отсутствующего.
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: agent.id },
      data: {
        frozenAt: null,
        frozenById: null,
        frozenReason: null,
        frozenReasonVoiceUrl: null,
        frozenReasonVoiceTranscript: null,
        // Вид и срок отсутствия живут ровно столько же, сколько сама заморозка:
        // оставленный absenceUntil заставил бы тик возврата снимать её повторно.
        absenceKind: null,
        absenceUntil: null,
      },
    });
    await shiftInactiveClockAfterAbsence(agent.id, agent.frozenAt, new Date(), tx);
  });
  logAudit(req, "AGENT_UNFREEZE", "Agent", agent.id, {});
  void syncAgentQueuePresence(agent.id).catch(() => {});
  res.json({ ok: true });
});

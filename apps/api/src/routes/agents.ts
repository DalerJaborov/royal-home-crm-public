import { Router, type Response } from "express";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { upload } from "../upload.js";
import { removeAgentAvatarFile, saveAgentAvatarFile } from "../lib/agentAvatarFile.js";
import { logSystemError } from "../lib/systemError.js";
import { readExtensionPool } from "../lib/telephony/extensionPool.js";
import {
  loadAgentDialMode,
  loadAriCredentials,
  originateCall,
  resolveAgentDialTarget,
} from "../lib/telephony/ariClient.js";
import { beginOrigination, endOrigination, hasLiveCall } from "../lib/telephony/callTracker.js";
import { sumPointsByAgent } from "../lib/pointsTotals.js";
import { anyParams } from "../lib/routeParams.js";
import {
  createStaffMember,
  deleteStaffMember,
  forbiddenDirectorTarget,
  freezeStaffMember,
  handoverStaffWork,
  listStaffDirectory,
  listStaffHandovers,
  pauseStaffLeads,
  readStaffPermissions,
  resetStaffTwoFactor,
  resumeStaffLeads,
  revertStaffHandover,
  setStaffPermissions,
  unfreezeStaffMember,
  updateStaffMember,
  type StaffOutcome,
} from "../lib/staffAdmin.js";

export const agentsRouter = Router();

// Управление учётками (создание/правка/удаление/аватар) — только ADMIN(+DIRECTOR).
// Журнал баллов на чтение доступен и MANAGER (тот же круг, что видит /team), поэтому
// авторизация проверяется здесь, а роль — по каждому роуту отдельно, а не одним общим use().
agentsRouter.use(requireAuth);

/**
 * ТЕЛА МАРШРУТОВ УПРАВЛЕНИЯ СОТРУДНИКАМИ — В lib/staffAdmin.ts (10.11.2026).
 * Те же функции зовёт ИИ-помощница (ai/assistant/tools/staffWriteTools.ts):
 * одна дверь на права, учётку директора и последнего директора. Здесь остаётся
 * граница входа — право на маршрут и подтверждение личности (requireElevation).
 */
function send(res: Response, outcome: StaffOutcome<unknown>) {
  return res.status(outcome.status).json(outcome.body);
}

/**
 * Список сотрудников. Менеджеру он тоже нужен — ему разрешено назначать лиды
 * (POST /clients/:id/assign) и менять риелтора объекта, но список был закрыт под
 * ADMIN, из-за чего выпадающий список агентов у него приходил пустым и разрешённое
 * действие нельзя было выполнить из интерфейса. Отдаём менеджеру справочник без
 * учётных данных: контакты, роль и KPI коллег — это админская зона.
 */
agentsRouter.get("/", requirePermission("agents.manage", "clients.assign", "team.viewFull"), async (req, res) => {
  res.json(await listStaffDirectory(req.agent!));
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
  send(res, await createStaffMember(req.agent!, req.body));
});

agentsRouter.patch("/:id", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  send(res, await updateStaffMember(req.agent!, req.params.id, req.body));
});

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
  send(res, await handoverStaffWork(req.agent!, req.params.id, req.body));
});

/**
 * Прошлые передачи дел сотрудника — для кнопки «Вернуть всё как было» в его
 * карточке (владелец 24.09.2026). Последние пять, новые первыми; по каждой —
 * что ушло и возвращена ли уже.
 */
agentsRouter.get("/:id/handovers", requirePermission("agents.manage"), async (req, res) => {
  res.json(await listStaffHandovers(req.params.id));
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
  send(res, await revertStaffHandover(req.agent!, req.params.batchId));
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
  send(res, await resetStaffTwoFactor(req.agent!, req.params.id));
});

agentsRouter.post("/:id/avatar", requirePermission("agents.manage"), requireElevation, anyParams(upload.single("avatar")), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });
  if (await forbiddenDirectorTarget(req.agent!, req.params.id)) {
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
  send(res, await deleteStaffMember(req.agent!, req.params.id));
});

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
  send(res, await readStaffPermissions(req.params.id));
});

agentsRouter.put("/:id/permissions", requirePermission("permissions.manage"), requireElevation, async (req, res) => {
  send(res, await setStaffPermissions(req.agent!, req.params.id, req.body));
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
  send(res, await freezeStaffMember(req.agent!, req.params.id, req.body));
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
  send(res, await pauseStaffLeads(req.agent!, req.params.id, req.body));
});

/** Руководитель снимает паузу — любую: и свою, и поставленную самим агентом. */
agentsRouter.delete("/:id/lead-pause", requirePermission("agents.manage"), async (req, res) => {
  send(res, await resumeStaffLeads(req.agent!, req.params.id));
});

/** Разморозка. Отдельным маршрутом, а не флагом в PATCH: это управленческое решение,
 *  и в журнале оно должно быть отдельной строкой, а не «изменены поля сотрудника». */
agentsRouter.post("/:id/unfreeze", requirePermission("agents.manage"), requireElevation, async (req, res) => {
  send(res, await unfreezeStaffMember(req.agent!, req.params.id));
});

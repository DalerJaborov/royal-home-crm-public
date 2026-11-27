import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ВЫКЛЮЧАТЕЛИ «АВТОМАТИКА ИИ И НАПОМИНАНИЯ» (владелец 19.11.2026: «оставить все эти
 * функции, просто сделать переключатели»).
 *
 * Здесь — общее: умолчание «всё включено», чтение из базы (lib/automationSwitches.ts),
 * сохранение через PATCH /settings с записью в журнал, подписи и группы экрана, и
 * «Много удалений у агента» (у него нет своего файла тестов). Остальные выключатели
 * проверены рядом с механизмом, на его же данных: card-auto-apply (карточка по звонку),
 * operator-showing-detect и showing-auto-book (показ по разговору агента),
 * candidate-intake-channels (соискатель), deal-stale-pipeline-deadline (покупатели),
 * client-waiting-alert, live-voice-inbound-push, property-stuck-materials.
 *
 * Общую строку Settings тест не выключает надолго: тесты сервера идут в два процесса на
 * одной базе. Выключение — подменой в этом файле, чтение из базы — в откатываемой
 * транзакции.
 */
const switchesOff = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return {
    ...actual,
    automationSwitchOn: async (...a: Parameters<typeof actual.automationSwitchOn>) =>
      switchesOff.has(a[0]) ? false : actual.automationSwitchOn(...a),
  };
});
const sendPushToAgents = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()),
  isWithinWorkingHours: async () => true,
}));

const shared = await import("@royal-home/shared");
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { automationSwitchOn } = await import("../src/lib/automationSwitches.js");
const { noteClientTrashedAndAlarmIfAnomalous } = await import("../src/lib/clientTrashAnomalyAlarm.js");
const { createTestAgent } = await import("./helpers/ownAgent.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const { AUTOMATION_SWITCH_KEYS, AUTOMATION_SWITCH_LABELS, AUTOMATION_SWITCH_GROUPS, isAutomationSwitchOn, automationSwitchLabel } = shared;

const runId = Date.now();
const agentIds: string[] = [];
const clientIds: string[] = [];
let directorId = "";
let ownerAgentId = "";
let token = "";

beforeAll(async () => {
  directorId = await createTestAgent(`Директор автоматики ${runId}`, "DIRECTOR");
  ownerAgentId = await createTestAgent(`Агент автоматики ${runId}`, "AGENT");
  agentIds.push(directorId, ownerAgentId);
  token = signAccessToken({ sub: directorId, role: "DIRECTOR" });
  grantElevation(directorId);
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

beforeEach(() => {
  switchesOff.clear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { tag: { startsWith: "client-trash-anomaly-" }, agentId: { in: agentIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.$disconnect();
});

describe("умолчание и подписи (packages/shared)", () => {
  it("нет строки или поля — всё включено, кроме «Записать результат» (по умолчанию выключено)", () => {
    for (const key of AUTOMATION_SWITCH_KEYS) {
      const want = !shared.AUTOMATION_SWITCH_DEFAULT_OFF.has(key);
      expect(isAutomationSwitchOn(null, key)).toBe(want);
      expect(isAutomationSwitchOn({}, key)).toBe(want);
      expect(isAutomationSwitchOn({ [key]: false }, key)).toBe(false);
      expect(isAutomationSwitchOn({ [key]: true }, key)).toBe(true);
    }
    // Выключенные по умолчанию — осознанный список: «Записать результат» и привязка Telegram по номеру (ревью 25.11.2026);
    // пуши хозяину объекта до заявки и о клиенте другого агента (владелец 27.11.2026: «пусть ничего не получает»);
    // пауза бота после ответа сотрудника (владелец 27.11.2026: «Убрать у всех»); строки робота в карточке («удали это»).
    expect([...shared.AUTOMATION_SWITCH_DEFAULT_OFF].sort()).toEqual(["botPauseOnStaffReplyEnabled", "clientCardRobotRowsEnabled", "clientRecordResultEnabled", "notifyDealClosedTeamPushEnabled", "notifyMarketMatchPushEnabled",
      "notifyNoVideoEnabled", "notifyOperatorTalkedPushEnabled", "notifyOwnerBeforeLeadEnabled", "notifyOwnerOfOtherAgentClientEnabled",
      "notifyRepeatContactPushEnabled", "shabnamGroupLiveShadowEnabled", "telegramPhoneLinkEnabled"]);
    const [first, second] = AUTOMATION_SWITCH_KEYS;
    expect(isAutomationSwitchOn({ [first]: false }, second)).toBe(true);
  });

  it("у каждого выключателя есть подпись на оба положения и своя группа на экране", () => {
    const inGroups = AUTOMATION_SWITCH_GROUPS.flatMap((g) => g.keys);
    expect(new Set(inGroups).size).toBe(inGroups.length);
    for (const key of AUTOMATION_SWITCH_KEYS) {
      const label = AUTOMATION_SWITCH_LABELS[key];
      expect(label.title.length, key).toBeGreaterThan(0);
      expect(label.on.length, key).toBeGreaterThan(0);
      expect(label.off.length, key).toBeGreaterThan(0);
      expect(inGroups, key).toContain(key);
    }
    // Уже существовавший выключатель «Застой: продавец без объекта» стоит в группе «Задачи» тем же полем.
    expect(AUTOMATION_SWITCH_GROUPS.find((g) => g.id === "tasks")?.keys).toContain("dealStaleSellersEnabled");
    expect(automationSwitchLabel("dealStaleSellersEnabled").title).toBe(shared.SELLER_SWITCH_LABELS.dealStaleSellersEnabled.title);
  });
});

describe("чтение из базы (lib/automationSwitches.ts)", () => {
  async function withRolledBack(data: Record<string, boolean>, check: (tx: Parameters<typeof automationSwitchOn>[1]) => Promise<void>) {
    const rollback = new Error("откат теста");
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.settings.update({ where: { id: "singleton" }, data });
        await check(tx);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  }

  it("миграция: колонки есть, и в строке настроек все включены (умолчание true)", async () => {
    const row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: Object.fromEntries(AUTOMATION_SWITCH_KEYS.map((k) => [k, true])) as Record<string, true>,
    });
    expect(row).not.toBeNull();
    for (const key of AUTOMATION_SWITCH_KEYS) expect((row as Record<string, unknown>)[key], key).toBe(!shared.AUTOMATION_SWITCH_DEFAULT_OFF.has(key));
    for (const key of AUTOMATION_SWITCH_KEYS) expect(await automationSwitchOn(key), key).toBe(!shared.AUTOMATION_SWITCH_DEFAULT_OFF.has(key));
  });

  it("выключен в базе — «нет» только у него", async () => {
    await withRolledBack({ aiCardFromCallEnabled: false }, async (tx) => {
      expect(await automationSwitchOn("aiCardFromCallEnabled", tx)).toBe(false);
      expect(await automationSwitchOn("aiAgentShowingAutoBookEnabled", tx)).toBe(true);
    });
  });
});

describe("сохранение через PATCH /settings", () => {
  it("принимает выключатель, отдаёт его в GET и пишет в журнал, кто выключил", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const got = await request(app).get("/api/v1/settings").set(auth);
    expect(got.status).toBe(200);
    for (const key of AUTOMATION_SWITCH_KEYS) expect(got.body[key], key).toBe(!shared.AUTOMATION_SWITCH_DEFAULT_OFF.has(key));

    // Общую строку настроек держим выключенной только на время одного запроса и возвращаем сразу прямой записью
    // (не вторым PATCH): окно гонки с соседними файлами — миллисекунды. Ключ выбран тот, что читает один редкий тест.
    const startedAt = new Date();
    let off;
    try {
      off = await request(app).patch("/api/v1/settings").set(auth).send({ notifyRobotTookCallEnabled: false });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { notifyRobotTookCallEnabled: true } });
    }
    expect(off.status).toBe(200);
    expect(off.body.notifyRobotTookCallEnabled).toBe(false);
    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { action: "SETTINGS_UPDATE", agentId: directorId, createdAt: { gte: startedAt } },
        orderBy: { createdAt: "desc" },
      })
    );
    expect(audit?.meta).toMatchObject({ notifyRobotTookCallEnabled: false });
    expect(await automationSwitchOn("notifyRobotTookCallEnabled")).toBe(true);
  });

  it("не boolean — 400", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set({ Authorization: `Bearer ${token}` })
      .send({ aiCardFromCallEnabled: "нет" });
    expect(res.status).toBe(400);
  });
});

describe("«Много удалений у агента» (lib/clientTrashAnomalyAlarm.ts)", () => {
  async function trashFive() {
    const deletedAt = new Date();
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push(
        await prisma.client.create({
          data: {
            fullName: `Удалённый ${runId}-${i}`,
            phone: `+99290${String(runId).slice(-6)}${i}`,
            source: "PHONE_CALL",
            assignedAgentId: ownerAgentId,
            deletedAt,
          },
        })
      );
    }
    clientIds.push(...rows.map((r) => r.id));
    return rows[4];
  }
  const tagOf = () => ({ tag: { startsWith: `client-trash-anomaly-${ownerAgentId}` } });

  it("выключен — уведомления нет; включён — директору приходит, как раньше", async () => {
    const last = await trashFive();
    const input = { agentId: ownerAgentId, client: { id: last.id, shortId: last.shortId, fullName: last.fullName } };

    switchesOff.add("notifyTrashAnomalyEnabled");
    try {
      await noteClientTrashedAndAlarmIfAnomalous(input);
      expect(sendPushToAgents).not.toHaveBeenCalled();
      expect(await prisma.notification.count({ where: tagOf() })).toBe(0);
    } finally {
      switchesOff.delete("notifyTrashAnomalyEnabled");
    }

    await noteClientTrashedAndAlarmIfAnomalous(input);
    const row = await waitFor(() => prisma.notification.findFirst({ where: tagOf() }));
    expect(row).not.toBeNull();
    expect(sendPushToAgents).toHaveBeenCalledTimes(1);
  });
});

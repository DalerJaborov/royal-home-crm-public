import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Сверка автора звонка с добавочным, которым реально была набрана запись (17.09.2026).
 *
 * Прод-разбор: карточка ПК-000236 (02.09) показывала звонок за Нозой (добавочный 1005),
 * а файл записи `out-900001036-1010-20260902-101041-….` набран с 1010 — это Умед. Три
 * таких расхождения за 30 дней из 273 исходящих. Причина: конвейер сохраняет запись по
 * тому, кого CRM ПРОСИЛА звонить (Interaction.agentId), и никогда не сверяет это с тем,
 * кто реально ответил станции — имя файла.
 *
 * Проверяется здесь: чистая функция разбора добавочного из имени файла и
 * reconcileCallAuthor — три исхода (переподписан / без изменений / добавочный ничей) —
 * без похода на станцию (findRecording/fetchRecording не участвуют, это отдельный слой,
 * покрытый call-recordings.test.ts).
 */

const { prisma } = await import("../src/db.js");
const { extensionFromRecordingName, reconcileCallAuthor } = await import("../src/lib/telephony/callRecordings.js");

const runId = Date.now();

let realAgentId = ""; // тот, кто реально набирал (добавочный из файла принадлежит ему)
let assignedAgentId = ""; // тот, за кем разговор числится в карточке
let clientId = "";

async function newInteraction(agentId: string, notes = "Звонок инициирован из CRM"): Promise<string> {
  const created = await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", notes },
  });
  return created.id;
}

async function loadAuthor(interactionId: string) {
  const row = await prisma.interaction.findUniqueOrThrow({
    where: { id: interactionId },
    select: { id: true, clientId: true, agentId: true, agent: { select: { id: true, fullName: true, sipExtension: true } } },
  });
  return row;
}

beforeAll(async () => {
  const real = await prisma.agent.create({
    data: {
      fullName: `Умед добавочный ${runId}`,
      phone: `+99295${String(runId).slice(-7)}1`,
      role: "AGENT",
      passwordHash: "x",
      isActive: true,
      sipExtension: `9${String(runId).slice(-3)}`,
    },
  });
  realAgentId = real.id;

  const assigned = await prisma.agent.create({
    data: {
      fullName: `Ноза числится ${runId}`,
      phone: `+99295${String(runId).slice(-7)}2`,
      role: "AGENT",
      passwordHash: "x",
      isActive: true,
      sipExtension: `8${String(runId).slice(-3)}`,
    },
  });
  assignedAgentId = assigned.id;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент сверки автора ${runId}`,
      phone: `+99296${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: assigned.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterEach(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.errorLog.deleteMany({ where: { source: "telephony", message: { contains: runId.toString() } } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [realAgentId, assignedAgentId] } } });
  await prisma.$disconnect();
});

describe("extensionFromRecordingName", () => {
  it("исходящий: добавочный — сегмент между номером клиента и датой", () => {
    expect(extensionFromRecordingName("out-900001036-1010-20260902-101041-1788325834.45.wav")).toBe("1010");
  });

  it("исходящий с путём каталога — тот же результат", () => {
    expect(extensionFromRecordingName("2026/09/02/out-900001036-1010-20260902-101041-1788325834.45.wav")).toBe("1010");
  });

  it("входящий — добавочного в имени нет, null", () => {
    expect(extensionFromRecordingName("in-112826161-20260917-101041-1788325834.45.wav")).toBeNull();
  });

  it("очередь (реальный формат входящего в этом коде) — тоже null", () => {
    expect(extensionFromRecordingName("q-покупатели-112826161-20260917-101041-1788325834.wav")).toBeNull();
  });
});

describe("reconcileCallAuthor", () => {
  it("добавочный в файле принадлежит другому активному агенту — переподписывает автора и пишет SYSTEM-заметку", async () => {
    const interactionId = await newInteraction(assignedAgentId);
    const author = await loadAuthor(interactionId);

    const realAgent = await prisma.agent.findUniqueOrThrow({ where: { id: realAgentId }, select: { sipExtension: true } });
    const recordingName = `out-883000000-${realAgent.sipExtension}-20260902-101041-1788325834.45.wav`;

    const outcome = await reconcileCallAuthor(author, author.agent, recordingName);
    expect(outcome.action).toBe("reassigned");

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(after.agentId).toBe(realAgentId);

    // П-10 (17.09.2026): заметку о переподписи пишет SYSTEM, не новый агент —
    // держатель виден через subjectAgentId, а не agentId (см. lib/timeline.ts).
    const systemNote = await prisma.interaction.findFirst({
      where: { clientId, type: "SYSTEM", subjectAgentId: realAgentId },
      orderBy: { createdAt: "desc" },
    });
    expect(systemNote?.actorKind).toBe("SYSTEM");
    expect(systemNote?.agentId).toBeNull();
    expect(systemNote?.notes).toContain("переподписан");
    expect(systemNote?.notes).toContain(realAgent.sipExtension as string);

    const errorRow = await prisma.errorLog.findFirst({
      where: { source: "telephony", message: { contains: "переподписан по добавочному" } },
      orderBy: { createdAt: "desc" },
    });
    expect(errorRow).toBeTruthy();
  });

  it("добавочный в файле совпадает с добавочным текущего автора — ничего не меняется", async () => {
    const interactionId = await newInteraction(assignedAgentId);
    const author = await loadAuthor(interactionId);
    const recordingName = `out-883000000-${author.agent.sipExtension}-20260902-101041-1788325834.45.wav`;

    const outcome = await reconcileCallAuthor(author, author.agent, recordingName);
    expect(outcome.action).toBe("unchanged");

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(after.agentId).toBe(assignedAgentId);

    const notesCount = await prisma.interaction.count({ where: { clientId, type: "SYSTEM" } });
    expect(notesCount).toBe(0);
  });

  it("входящий (без добавочного в имени) — сверка не срабатывает вовсе", async () => {
    const interactionId = await newInteraction(assignedAgentId);
    const author = await loadAuthor(interactionId);

    const outcome = await reconcileCallAuthor(author, author.agent, "q-покупатели-112826161-20260917-101041-1788325834.wav");
    expect(outcome.action).toBe("unchanged");

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(after.agentId).toBe(assignedAgentId);
  });

  it("добавочный в файле никому не принадлежит — автор не меняется, есть запись в журнале ошибок", async () => {
    const interactionId = await newInteraction(assignedAgentId);
    const author = await loadAuthor(interactionId);
    const orphanExt = `7${String(runId).slice(-3)}`;
    const recordingName = `out-883000000-${orphanExt}-20260902-101041-1788325834.45.wav`;

    const outcome = await reconcileCallAuthor(author, author.agent, recordingName);
    expect(outcome.action).toBe("orphan-extension");

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(after.agentId).toBe(assignedAgentId);

    const notesCount = await prisma.interaction.count({ where: { clientId, type: "SYSTEM" } });
    expect(notesCount).toBe(0);

    const errorRow = await prisma.errorLog.findFirst({
      where: { source: "telephony", message: { contains: `добавочного ${orphanExt}` } },
      orderBy: { createdAt: "desc" },
    });
    expect(errorRow).toBeTruthy();
  });

  it("слабое совпадение (weakMatch): чужой добавочный — запись отклоняется, а не переподписывается", async () => {
    const interactionId = await newInteraction(assignedAgentId);
    const author = await loadAuthor(interactionId);
    const realAgent = await prisma.agent.findUniqueOrThrow({ where: { id: realAgentId }, select: { sipExtension: true } });
    const recordingName = `out-883000000-${realAgent.sipExtension}-20260902-101041-1788325834.45.wav`;

    const outcome = await reconcileCallAuthor(author, author.agent, recordingName, { weakMatch: true });
    expect(outcome.action).toBe("rejected");

    const after = await prisma.interaction.findUniqueOrThrow({ where: { id: interactionId } });
    expect(after.agentId).toBe(assignedAgentId);

    const notesCount = await prisma.interaction.count({ where: { clientId, type: "SYSTEM" } });
    expect(notesCount).toBe(0);

    const errorRow = await prisma.errorLog.findFirst({
      where: { source: "telephony", message: { contains: "похожа на чужую" } },
      orderBy: { createdAt: "desc" },
    });
    expect(errorRow).toBeTruthy();
  });
});

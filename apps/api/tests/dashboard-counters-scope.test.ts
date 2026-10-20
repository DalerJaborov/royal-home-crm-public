import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Красные значки в меню обязаны считать РОВНО ТО, что человек увидит, открыв раздел.
 *
 * Правило записано в самом routes/dashboard.ts (счётчик вакансий, 03.09.2026), но
 * два значка его нарушали, и оба одинаково: обещали больше, чем показывает вкладка.
 *
 *  — «Мои звонки»: считались разговоры, ждущие разбора, по ВСЕМУ агентству, а лента
 *    (GET /calls/feed) отдаёт агенту только то, что касается лично его. В меню горит
 *    «3», агент открывает раздел — пусто, все три звонка чужие.
 *  — «Клиенты»: к своим карточкам подмешивалось `acceptedAt: null` — то есть чужие
 *    непринятые заявки (утренняя волна раздаёт лид конкретному агенту ДО того, как
 *    его приняли) и очередь на волну, не назначенная никому. Ни то, ни другое в
 *    списке агента появиться не может.
 *
 * ИЗОЛЯЦИЯ ОТ СОСЕДНИХ ФАЙЛОВ. База общая на весь прогон, а значки считают «новое с
 * последнего визита в раздел» (Agent.sectionsSeenAt). Поэтому каждому участнику
 * теста метка визита ставится руками на момент T0, а все записи заводятся строго
 * ПОЗЖЕ T0 — чужие строки, созданные до, в счётчик не попадают по определению
 * самого счётчика, а не потому что мы что-то замолчали.
 */

const runId = Date.now();
/** Момент «последнего визита в раздел»; всё своё заводится на секунду позже. */
const T0 = new Date(runId);
const AFTER_T0 = new Date(runId + 1000);

let agentAId = "";
let agentBId = "";
let adminId = "";
let managerId = "";
let agentAToken = "";
let agentBToken = "";
let adminToken = "";
let managerToken = "";
const agentAExtension = `9${String(runId).slice(-3)}`;

const createdClientIds: string[] = [];
const createdCallIds: string[] = [];

/** Метки визита во все разделы сразу — счётчику важны только «clients» и «calls». */
const seenAtT0 = { clients: T0.toISOString(), sellers: T0.toISOString(), calls: T0.toISOString() };

let agentSeq = 0;

async function makeAgent(label: string, role: "AGENT" | "ADMIN" | "MANAGER", sipExtension?: string) {
  return prisma.agent.create({
    data: {
      fullName: `${label} значков ${runId}`,
      phone: `+9927${agentSeq++}${String(runId).slice(-7)}`,
      role,
      passwordHash: "x",
      sectionsSeenAt: seenAtT0,
      ...(sipExtension ? { sipExtension } : {}),
    },
  });
}

async function makeClient(name: string, assignedAgentId: string | null, acceptedAt: Date | null) {
  const client = await prisma.client.create({
    data: {
      fullName: `${name} ${runId}`,
      phone: `+992${String(runId).slice(-6)}${createdClientIds.length}`,
      source: "PHONE_CALL",
      kind: "BUYER",
      createdAt: AFTER_T0,
      assignedAgentId,
      acceptedAt,
    },
  });
  createdClientIds.push(client.id);
  return client;
}

/** Звонок «ждёт разбора» по AWAITING_REVIEW_WHERE: разговор состоялся, карточка
 *  есть, тип обращения не указан. */
async function makeAwaitingCall(clientId: string, answeredBy?: string) {
  const call = await prisma.incomingCall.create({
    data: {
      channelId: `wt-${runId}-${createdCallIds.length}`,
      phone: `+992900${String(runId).slice(-4)}`,
      startedAt: AFTER_T0,
      answered: true,
      clientId,
      qualifiedAt: null,
      ...(answeredBy ? { answeredBy } : {}),
    },
  });
  createdCallIds.push(call.id);
  return call;
}

beforeAll(async () => {
  const [a, b, admin, manager] = await Promise.all([
    makeAgent("Агент А", "AGENT", agentAExtension),
    makeAgent("Агент Б", "AGENT"),
    makeAgent("Админ", "ADMIN"),
    makeAgent("Руководитель", "MANAGER"),
  ]);
  agentAId = a.id;
  agentBId = b.id;
  adminId = admin.id;
  managerId = manager.id;
  agentAToken = signAccessToken({ sub: a.id, role: "AGENT" });
  agentBToken = signAccessToken({ sub: b.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });
  managerToken = signAccessToken({ sub: manager.id, role: "MANAGER" });

  // Карточки: своя принятая, своя ещё не принятая, чужая непринятая и очередь на
  // утреннюю волну (не назначена никому). Последние две — ровно то, что счётчик
  // подмешивал агенту А, хотя в его списке их нет.
  const mineAccepted = await makeClient("Свой принятый", agentAId, new Date());
  await makeClient("Свой непринятый", agentAId, null);
  const otherUnaccepted = await makeClient("Чужой непринятый", agentBId, null);
  await makeClient("Очередь волны", null, null);

  // Звонки, ждущие разбора: по своему клиенту, по чужому, и чужой клиент, но трубку
  // снял сам агент А (третий способ оказаться причастным — answeredBy).
  await makeAwaitingCall(mineAccepted.id);
  await makeAwaitingCall(otherUnaccepted.id);
  await makeAwaitingCall(otherUnaccepted.id, agentAExtension);
});

afterAll(async () => {
  await prisma.incomingCall.deleteMany({ where: { id: { in: createdCallIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentAId, agentBId, adminId, managerId] } } });
  await prisma.$disconnect();
});

async function counters(token: string) {
  const res = await request(app).get("/api/v1/dashboard/counters").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body as Record<string, number>;
}

describe("Значок «Мои звонки»", () => {
  it("агенту — только звонки, которые касаются лично его", async () => {
    // Свой клиент + чужой клиент, но трубку снял он сам. Третий звонок — целиком
    // чужой, и до правки он тоже горел в значке, хотя в ленте агента его нет.
    expect((await counters(agentAToken)).calls).toBe(2);
  });

  it("другому агенту — его собственный звонок, а не те же самые три", async () => {
    // Два звонка заведены по клиенту агента Б; один из них ответил агент А, но
    // ведёт клиента по-прежнему Б — для Б причастны оба.
    expect((await counters(agentBToken)).calls).toBe(2);
  });

  it("руководству — по всему агентству, как и раздел", async () => {
    expect((await counters(adminToken)).calls).toBe(3);
  });
});

describe("Значок «Клиенты»", () => {
  it("агенту — только назначенные ему, включая ещё не принятые им", async () => {
    // Своя принятая + своя непринятая. Чужая непринятая и очередь волны — нет:
    // открыв «Клиенты», агент их не увидит (routes/clients/list.ts).
    expect((await counters(agentAToken)).clients).toBe(2);
  });

  it("чужие непринятые не подмешиваются другому агенту", async () => {
    expect((await counters(agentBToken)).clients).toBe(1);
  });

  it("руководителю счётчик не сузился — у него ownAgentId пуст", async () => {
    // Проверка обратной стороны правки: scopeToOwnAgent возвращает undefined тому,
    // у кого есть clients.viewAll, и значок обязан продолжать считать все четыре
    // карточки, а не превратиться в «свои» и обнулиться.
    expect((await counters(adminToken)).clients).toBe(4);
  });
});

/**
 * Руководитель (MANAGER) — единственная роль, у которой два этих значка обязаны
 * считаться ПО-РАЗНОМУ одному и тому же человеку: в пресете у него есть
 * clients.viewAll, но из звонков только calls.ownTranscripts («руководитель тоже
 * звонит клиентам — свой разговор он слышит, чужие нет»).
 *
 * Ради этого случая счётчики и спрашивают каждый СВОЁ право, а не общий признак
 * «начальник»: с одним флагом на оба один из двух значков разошёлся бы со своим
 * разделом — ровно та беда, из-за которой в middleware.ts когда-то развели
 * scopeToOwnAgent и scopeDealsToOwnAgent.
 */
describe("Руководитель: клиенты по агентству, звонки только свои", () => {
  it("«Клиенты» — все карточки (у него clients.viewAll)", async () => {
    expect((await counters(managerToken)).clients).toBe(4);
  });

  it("«Мои звонки» — ноль: ни один из трёх звонков его не касается", async () => {
    // Ни callbackAgentId, ни клиент, ни снятая трубка — а лента звонков (GET
    // /calls/feed) сузится для него ровно так же, потому что calls.transcripts
    // у него нет.
    expect((await counters(managerToken)).calls).toBe(0);
  });
});

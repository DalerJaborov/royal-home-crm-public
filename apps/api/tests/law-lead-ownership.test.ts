import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import { manualDataCorrectionSchema } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { changeClientAgent } from "../src/lib/changeClientAgent.js";
import { preferredReturningOwnerId } from "../src/lib/returningClientRouting.js";
import { computeHiddenReason } from "../src/routes/clients/shared.js";
import {
  hasContactAttempt,
  canAutoTransfer,
  requireHumanActor,
  type OwnershipSnapshot,
} from "../src/services/leads/ownershipPolicy.js";

/**
 * Закон о владении клиентом (17.09.2026) — `docs/law/lead-ownership.md`.
 * Тесты именуются `П-N: …`; мета-тест ниже требует хотя бы один такой тест на
 * каждый номер, помеченный реализованным в включённой пачке, а на остальные —
 * `it.todo("П-N")`, чтобы неполнота была видна, а не потерялась молча.
 */

function snapshot(overrides: Partial<OwnershipSnapshot> = {}): OwnershipSnapshot {
  return {
    id: "client-1",
    assignedAgentId: "agent-1",
    acceptedAt: null,
    firstContactAt: null,
    lastAgentAttemptAt: null,
    contactAttempts: 0,
    ownPropertyLead: false,
    kind: "BUYER",
    status: "NEW",
    workStatus: "ACTIVE",
    deletedAt: null,
    ...overrides,
  };
}

describe("Закон о владении клиентом — чистые функции", () => {
  it("П-2: firstContactAt делает hasContactAttempt истинным", () => {
    expect(hasContactAttempt(snapshot({ firstContactAt: new Date() }))).toBe(true);
  });

  it("П-2: lastAgentAttemptAt делает hasContactAttempt истинным", () => {
    expect(hasContactAttempt(snapshot({ lastAgentAttemptAt: new Date() }))).toBe(true);
  });

  it("П-2: contactAttempts > 0 делает hasContactAttempt истинным", () => {
    expect(hasContactAttempt(snapshot({ contactAttempts: 1 }))).toBe(true);
  });

  it("П-2: без единого признака контакта hasContactAttempt ложно", () => {
    expect(hasContactAttempt(snapshot())).toBe(false);
  });

  it("П-1: удалённый клиент — автопередача запрещена, ruleNo П-1, независимо от контакта", () => {
    const v = canAutoTransfer(snapshot({ deletedAt: new Date() }), { mechanism: "test", toAgentId: "agent-2" });
    expect(v).toEqual({ allowed: false, ruleNo: "П-1", reason: expect.any(String) });
  });

  it("П-3: принят и контакт состоялся — автопередача запрещена, ruleNo П-3", () => {
    const v = canAutoTransfer(
      snapshot({ acceptedAt: new Date(), firstContactAt: new Date() }),
      { mechanism: "reassignment.stale", toAgentId: "agent-2" }
    );
    expect(v).toEqual({ allowed: false, ruleNo: "П-3", reason: expect.any(String) });
  });

  it("П-3: принят, но контакта НЕ было — автопередача разрешена (П-4, а не П-3)", () => {
    const v = canAutoTransfer(snapshot({ acceptedAt: new Date() }), { mechanism: "reassignment.stale", toAgentId: "agent-2" });
    expect(v).toEqual({ allowed: true });
  });

  it("П-3: контакт был, но НЕ принят — автопередача разрешена (П-3 требует ОБА условия)", () => {
    const v = canAutoTransfer(snapshot({ firstContactAt: new Date() }), { mechanism: "reassignment.stale", toAgentId: "agent-2" });
    expect(v).toEqual({ allowed: true });
  });

  it("П-5: lifecycle.assign/restore/freeze/handover требуют actorId", () => {
    expect(requireHumanActor("lifecycle.assign")).toBe(true);
    expect(requireHumanActor("restore")).toBe(true);
    expect(requireHumanActor("freeze")).toBe(true);
    expect(requireHumanActor("handover")).toBe(true);
  });

  it("П-5: автоматические источники этой пачки НЕ входят в человеческий список", () => {
    expect(requireHumanActor("reassignment.stale")).toBe(false);
    expect(requireHumanActor("firstCall.reassign")).toBe(false);
    expect(requireHumanActor("reassignment.returns")).toBe(false);
  });
});

describe("Закон о владении клиентом — интеграция в changeClientAgent", () => {
  const runId = Date.now();
  let holderId: string;
  let nextAgentId: string;
  let supervisorId: string;
  const clientIds: string[] = [];

  async function makeClient(data: Record<string, unknown>) {
    const c = await prisma.client.create({
      data: {
        fullName: `Закон П-3 ${runId}-${clientIds.length}`,
        phone: `+992909${runId}${clientIds.length}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: holderId,
        assignedAt: new Date(Date.now() - 30 * 60_000),
        ...data,
      },
    });
    clientIds.push(c.id);
    return c;
  }

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("x", 10);
    holderId = (
      await prisma.agent.create({ data: { fullName: "Держатель закона", phone: `+992964${runId}`, role: "AGENT", passwordHash } })
    ).id;
    nextAgentId = (
      await prisma.agent.create({ data: { fullName: "Следующий по закону", phone: `+992963${runId}`, role: "AGENT", passwordHash } })
    ).id;
    supervisorId = (
      await prisma.agent.create({ data: { fullName: "Руководитель закона", phone: `+992962${runId}`, role: "DIRECTOR", passwordHash } })
    ).id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { agentId: { in: [holderId, nextAgentId, supervisorId] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: clientIds } } });
    await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: [holderId, nextAgentId, supervisorId] } } });
  });

  it("П-3: принятый клиент с попыткой дозвона не передаётся автоматикой (reassignment.stale) — эскалация вместо передачи", async () => {
    const client = await makeClient({ acceptedAt: new Date(), lastAgentAttemptAt: new Date() });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: nextAgentId,
      reason: "тест: карусель не принявших",
      actorId: null,
      source: "reassignment.stale",
      data: { assignedAt: new Date() },
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "policy", ruleNo: "П-3" }));
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(holderId);
    const escalation = await prisma.interaction.findFirst({
      where: { clientId: client.id, type: "SYSTEM", notes: { startsWith: "Автопередача запрещена законом П-3" } },
    });
    expect(escalation).not.toBeNull();
  });

  it("П-3: принятый клиент с попыткой дозвона не передаётся автоматикой (firstCall.reassign) — та же защита, другой механизм", async () => {
    const client = await makeClient({ acceptedAt: new Date(), firstContactAt: new Date() });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: nextAgentId,
      reason: "тест: срыв первого звонка",
      actorId: null,
      source: "firstCall.reassign",
      data: { assignedAt: new Date(), acceptedAt: null },
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "policy", ruleNo: "П-3" }));
  });

  it("П-4: принятый клиент БЕЗ единой попытки — автоматика передаёт как раньше", async () => {
    const client = await makeClient({ acceptedAt: new Date() });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: nextAgentId,
      reason: "тест: срыв первого звонка без попытки",
      actorId: null,
      source: "firstCall.reassign",
      data: { assignedAt: new Date(), acceptedAt: null },
    });

    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(nextAgentId);
  });

  it("П-5: человек с actorId передаёт принятого и контактного клиента всегда (П-3 действует только на автоматику)", async () => {
    const client = await makeClient({ acceptedAt: new Date(), firstContactAt: new Date() });

    const result = await changeClientAgent({
      clientId: client.id,
      toAgentId: nextAgentId,
      reason: "тест: руководитель передал вручную",
      actorId: supervisorId,
      source: "lifecycle.assign",
      data: {},
    });

    expect(result.ok).toBe(true);
    const after = await prisma.client.findUnique({ where: { id: client.id }, select: { assignedAgentId: true } });
    expect(after?.assignedAgentId).toBe(nextAgentId);
  });

  it("П-5: источник-человек без actorId — ошибка (dev/test), запись не создаётся", async () => {
    const client = await makeClient({ acceptedAt: new Date() });

    await expect(
      changeClientAgent({
        clientId: client.id,
        toAgentId: nextAgentId,
        reason: "тест: забыли передать актора",
        source: "lifecycle.assign",
        data: {},
      })
    ).rejects.toThrow();
  });

  // П-8/П-11/П-12: contract tests below complement the actual PostgreSQL suites.
  // P-12 covers registered CLIENT_LABELS only, never arbitrary database repairs.

  it("П-8: текущий активный держатель приоритетнее истории, отсутствие держателей даёт очередь", async () => {
    expect(await preferredReturningOwnerId(holderId, nextAgentId)).toBe(holderId);
    expect(await preferredReturningOwnerId(null, nextAgentId)).toBe(nextAgentId);
    expect(await preferredReturningOwnerId(null, null)).toBeNull();
  });

  it("П-11: обычные причины видимости объясняются без признаков закрытого разбора", () => {
    const base = { deletedAt: null, kind: "BUYER" as const, status: "NEW", workStatus: "ACTIVE", acceptedAt: new Date(), securityReview: "PENDING" };
    for (const role of ["AGENT", "MANAGER", "SECURITY"]) {
      expect(computeHiddenReason(base, role)).toBeNull();
      expect(computeHiddenReason({ ...base, deletedAt: new Date() }, role)?.kind).toBe("trashed");
      expect(computeHiddenReason({ ...base, kind: "OTHER" }, role)?.kind).toBe("other");
      expect(computeHiddenReason({ ...base, workStatus: "INACTIVE" }, role)?.kind).toBe("inactive");
      expect(computeHiddenReason({ ...base, status: "LOST" }, role)?.kind).toBe("lost");
      expect(computeHiddenReason({ ...base, workStatus: "DEFERRED", deferredUntil: new Date() }, role)?.kind).toBe("deferred");
    }
    expect(computeHiddenReason(base, "ADMIN")?.kind).toBe("securityReview");
  });

  it("П-12: зарегистрированное исправление допускает только имя/фамилию, не SQL или поля процесса", () => {
    const target = { clientId: "00000000-0000-4000-8000-000000000001", patch: { fullName: "Исправленное имя", lastName: "Фамилия" } };
    const command = { requestKey: "00000000-0000-4000-8000-000000000002", actorId: "00000000-0000-4000-8000-000000000003",
      operation: "CLIENT_LABELS", reason: "Подтверждённое исправление опечатки в имени", targets: [target] };
    expect(manualDataCorrectionSchema.safeParse(command).success).toBe(true);
    for (const patch of [{}, { assignedAgentId: target.clientId }, { status: "NEW" }, { securityReview: "CLEARED" },
      { phone: "+992911234567" }, { assignmentCompletedAt: null }, { fullName: "Имя", nextAction: "Задача" }]) {
      expect(manualDataCorrectionSchema.safeParse({ ...command, targets: [{ ...target, patch }] }).success).toBe(false);
    }
    expect(manualDataCorrectionSchema.safeParse({ ...command, operation: "SQL", sql: "UPDATE Client SET status='NEW'" }).success).toBe(false);
    expect(manualDataCorrectionSchema.safeParse({ ...command, targets: [target, target] }).success).toBe(false);
    // Presence of the executable integration suite is a coverage link, not a claim
    // that inspecting its source proves its assertions. Root runs it on isolated PG.
    const suitePath = fileURLToPath(new URL("./manual-data-correction.test.ts", import.meta.url));
    expect(fs.existsSync(suitePath)).toBe(true);
    const suite = fs.readFileSync(suitePath, "utf8");
    expect(suite).toContain("await applyManualCorrection(command)");
    expect(suite).toContain('toBe("ALREADY_APPLIED")');
    expect(suite).toContain("rolls back the entire multi-card plan");
  });

  /**
   * П-6 (пачка А2). Содержательная интеграционная проверка — releaseCandidates
   * в lib/leadAccept.ts (исключает клиентов с контактом из списка «отдать») и
   * tests/lead-active-limit.test.ts / tests/lead-over-limit.test.ts. Здесь —
   * source-проверка, что режим "random" (система сама выбирает жертву) больше
   * нигде не читается в самой функции приёма.
   */
  it("П-6: портфель полон — система не выбирает жертву сама, режим random не используется в приёме", () => {
    const src = fs.readFileSync(
      path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/lib/leadAccept.ts"),
      "utf-8"
    );
    expect(src).not.toMatch(/releaseMode/);
    expect(src).toMatch(/firstContactAt:\s*null/);
    expect(src).toMatch(/lastAgentAttemptAt:\s*null/);
  });

  /**
   * П-7 (пачка А2). handoverAgentWork принимает actorId и пишет его в каждую
   * передачу клиента (см. lib/agentHandover.ts:71,153); оба вызывающих
   * (routes/agents.ts — увольнение и заморозка) передают req.agent!.id.
   * Содержательные интеграционные тесты — agent-handover.test.ts,
   * agent-handover-split.test.ts, agent-delete-handover.test.ts.
   */
  it("П-7: увольнение/заморозка — раздача портфеля несёт actorId руководителя", () => {
    const lib = fs.readFileSync(
      path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/lib/agentHandover.ts"),
      "utf-8"
    );
    expect(lib).toMatch(/actorId\?:\s*string\s*\|\s*null/);
    const routes = fs.readFileSync(
      path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/routes/agents.ts"),
      "utf-8"
    );
    expect(routes.match(/handoverAgentWork\([^)]*req\.agent!\.id\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * П-9 (пачка А2). lib/clientMerge.ts::recordMergeOwnershipChange — если у
   * дубля был свой агент, запись о передаче + уведомление обоим. Содержательные
   * тесты — client-merge.test.ts, client-merge-force-similar.test.ts.
   */
  it("П-9: слияние дублей с разными агентами пишет передачу и уведомляет обоих", () => {
    const src = fs.readFileSync(
      path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/lib/clientMerge.ts"),
      "utf-8"
    );
    expect(src).toMatch(/recordMergeOwnershipChange/);
    expect(src).toMatch(/duplicate\.assignedAgentId\s*!==\s*primary\.assignedAgentId/);
  });

  /**
   * П-10 (задание Б1, 17.09.2026). Содержательные тесты живут в отдельном
   * файле tests/law-timeline.test.ts (создан тем же заданием, до слияния веток
   * не мог лежать здесь — см. комментарий в его шапке) — actorKind
   * AGENT/SYSTEM/AI/BOT/CLIENT, agentId=null у не-агента, единственный писатель
   * lib/timeline.ts (страж tests/timeline-single-writer.test.ts). Здесь —
   * явная ссылка, чтобы «полнота по номерам закона» видела П-10 покрытым.
   */
  it("П-10: каждая запись хронологии подписана актором — см. tests/law-timeline.test.ts", () => {
    expect(fs.existsSync(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "./law-timeline.test.ts"))).toBe(
      true
    );
  });
});

/**
 * МЕТА-ТЕСТ ПОЛНОТЫ. Парсит `docs/law/lead-ownership.md`: для каждого `## П-N.`
 * читает следующую строку `**Статус:** …` и, если она содержит «реализовано в
 * <пачка>» (любая из уже слитых в этой ветке — А1, А2, Б1), требует хотя бы
 * один `it("П-N: …")` где-то в ЭТОМ файле; иначе требует `it.todo("П-N")`. Не
 * даёт закону разойтись с тестами молча — ни забытый номер, ни забытый it.todo
 * не проскочат.
 *
 * 25.10.2026 включены В/Г после isolated-PG подтверждения возвратов и
 * зарегистрированного ручного исправления. Статусы описывают конкретный scope
 * закона, а не обещают поддержку произвольных полей или новых уведомлений.
 */
describe("Закон о владении клиентом — полнота (мета-тест)", () => {
  const LAW_PATH = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../docs/law/lead-ownership.md");
  const THIS_FILE = fileURLToPath(new URL(".", import.meta.url)) + "law-lead-ownership.test.ts";
  const IMPLEMENTED_BATCHES = /реализовано в (А1|А2|Б1|В|Г)/;

  it("на каждый номер закона со статусом «реализовано в <слитая пачка>» есть хотя бы один it(\"П-N: …\"), на остальные — it.todo", () => {
    // \r\n → \n: найдено 17.09.2026 при слиянии — CRLF в docs/law/lead-ownership.md
    // (autocrlf на Windows) ломал regex ниже вчистую (0 совпадений вместо 12) без
    // единого намёка на причину. Нормализуем здесь, а не полагаемся на то, что
    // файл навсегда останется LF в рабочем дереве.
    const lawSrc = fs.readFileSync(LAW_PATH, "utf-8").replace(/\r\n/g, "\n");
    const testSrc = fs.readFileSync(THIS_FILE, "utf-8");

    const ruleRe = /^##\s*(П-\d+)\.[^\n]*\n+\*\*Статус:\*\*\s*([^\n]*)/gm;
    const rules: { id: string; realized: boolean }[] = [];
    for (const m of lawSrc.matchAll(ruleRe)) {
      rules.push({ id: m[1], realized: IMPLEMENTED_BATCHES.test(m[2]) });
    }
    expect(rules.length).toBeGreaterThanOrEqual(12); // П-1…П-12 — если меньше, парсер сломан или закон урезан

    const missing: string[] = [];
    for (const rule of rules) {
      if (rule.realized) {
        const hasTest = new RegExp(`it\\(\\s*["'\`]${rule.id}:`).test(testSrc);
        if (!hasTest) missing.push(`${rule.id}: помечен «реализовано», но нет it("${rule.id}: …")`);
      } else {
        const hasTodo = new RegExp(`it\\.todo\\(\\s*["'\`]${rule.id}["'\`]`).test(testSrc);
        if (!hasTodo) missing.push(`${rule.id}: не помечен «реализовано», но нет it.todo("${rule.id}")`);
      }
    }
    expect(missing).toEqual([]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";

/**
 * АКЦИОНЕР: ОТЧЁТЫ — ДА, ТРЕВОГИ С ДЕЙСТВИЕМ — НЕТ, ШАБНАМ — ТОЛЬКО ЧТЕНИЕ (27.11.2026).
 *
 * Владелец: «добавь нового учредителя… к Шабнам подключим его, с автоматическими
 * отчётами как и у директора». Проверяем три двери:
 *  - lib/recipients.ts — режим просмотра не получатель тревог по умолчанию;
 *  - lib/reportRecipients.ts — отчёты для чтения ему идут под рубильником;
 *  - lib/assistantActions.ts + ai/assistant/tools/index.ts — запись помощницы ему закрыта.
 * И «прислать финансовый PDF сейчас» (lib/reportPdf/ownTelegram.ts). Транспорт Telegram и
 * сборка PDF подменены: к Telegram и к рендеру тест не ходит.
 */
const { sendDocumentFile, buildReportPdf } = vi.hoisted(() => ({
  sendDocumentFile: vi.fn(async (_chatId: string, _file: unknown, _name: string, _caption?: string) => ({ message_id: 1 })),
  buildReportPdf: vi.fn(async (_kind: string, _q: unknown, _viewer: unknown, _now?: Date) => ({
    buffer: Buffer.from("%PDF-1.4 test"),
    filename: "finance.pdf",
    periodLabel: "Ноябрь 2026",
    periodKey: "2026-11",
  })),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendDocumentFile,
}));
vi.mock("../src/lib/reportPdf/build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/reportPdf/build.js")>()),
  buildReportPdf,
}));

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { prisma } = await import("../src/db.js");
const { findAgentsWithPermission } = await import("../src/lib/recipients.js");
const { findAutoPdfRecipients, findReportRecipients, findReportRecipientsByRoles, reportRecipientRoles } = await import("../src/lib/reportRecipients.js");
const fs = await import("node:fs");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { sendDirectorDigest } = await import("../src/cron.js");
const { sendMonthlyFinancePdf } = await import("../src/lib/reportPdf/monthlyFinance.js");
const { sendPushToAgent } = await import("../src/push.js");
const { loadAgentAccess } = await import("../src/auth/middleware.js");
const { actorFromAccess } = await import("../src/ai/assistant/actor.js");
const { pluginDeclarations } = await import("../src/ai/assistant.js");
const { listAssistantToolPlugins, assistantPluginAllowed, findAssistantToolPlugin } = await import("../src/ai/assistant/tools/index.js");
const { runAssistantToolPlugin } = await import("../src/ai/assistant/tools/run.js");
const { createPendingAssistantAction, AssistantActionError } = await import("../src/lib/assistantActions.js");
const { resetOwnTelegramPdfCooldown } = await import("../src/lib/reportPdf/ownTelegram.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitFor } = await import("./helpers/waitFor.js");

const runId = Date.now();
const ids: string[] = [];
let shareholderId: string;
let directorId: string;
let agentId: string;
let adminId: string;
let adminNoMoneyId: string;
let ropId: string;
let savedSettings: { shareholderReportsEnabled: boolean; financePdfMonthlyEnabled: boolean; financePdfMonthlyLastSent: string | null };

async function makeAgent(role: "SHAREHOLDER" | "DIRECTOR" | "AGENT" | "ADMIN" | "HEAD_OF_SALES", chat: string | null) {
  const a = await prisma.agent.create({
    data: {
      fullName: `Тест ${role} ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      telegramChatId: chat,
    },
  });
  ids.push(a.id);
  return a.id;
}

async function setReports(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { shareholderReportsEnabled: on } });
}

beforeAll(async () => {
  savedSettings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { shareholderReportsEnabled: true, financePdfMonthlyEnabled: true, financePdfMonthlyLastSent: true },
  });
  shareholderId = await makeAgent("SHAREHOLDER", `81${String(runId).slice(-8)}`);
  directorId = await makeAgent("DIRECTOR", null);
  agentId = await makeAgent("AGENT", `82${String(runId).slice(-8)}`);
  adminId = await makeAgent("ADMIN", `83${String(runId).slice(-8)}`);
  adminNoMoneyId = await makeAgent("ADMIN", `84${String(runId).slice(-8)}`);
  await prisma.agent.update({ where: { id: adminNoMoneyId }, data: { permissions: { granted: [], revoked: ["finance.view"] } } });
  ropId = await makeAgent("HEAD_OF_SALES", `85${String(runId).slice(-8)}`);
});

afterAll(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.notification.deleteMany({ where: { agentId: { in: ids } } });
  await deleteAgentsWithTraces(ids);
});

beforeEach(async () => {
  sendDocumentFile.mockClear();
  buildReportPdf.mockClear();
  resetOwnTelegramPdfCooldown();
  await setReports(true);
});

describe("получатели: тревоги — нет, отчёты — под рубильником", () => {
  it("тревога по праву (messages.view, finance.view) акционеру не идёт", async () => {
    expect(await findAgentsWithPermission("messages.view")).not.toContain(shareholderId);
    expect(await findAgentsWithPermission("finance.view")).not.toContain(shareholderId);
    expect(await findAgentsWithPermission("finance.view")).toContain(directorId);
  });

  it("отчёт по праву — акционеру при ВКЛ, нет при ВЫКЛ", async () => {
    expect(await findReportRecipients("dashboard.analytics")).toContain(shareholderId);
    expect(await reportRecipientRoles(["DIRECTOR", "ADMIN"])).toContain("SHAREHOLDER");
    await setReports(false);
    expect(await findReportRecipients("dashboard.analytics")).not.toContain(shareholderId);
    expect(await findReportRecipientsByRoles(["DIRECTOR", "ADMIN"])).not.toContain(shareholderId);
    expect(await reportRecipientRoles(["DIRECTOR", "ADMIN"])).toEqual(["DIRECTOR", "ADMIN"]);
  });

  it("утренняя сводка: акционер получает её в колокольчик наравне с директором", async () => {
    await sendDirectorDigest();
    const forShareholder = await waitFor(() =>
      prisma.notification.findFirst({ where: { agentId: shareholderId, tag: "director-digest" } }),
    );
    expect(forShareholder?.title).toContain("Утренняя сводка");
    await waitFor(() => prisma.notification.findFirst({ where: { agentId: directorId, tag: "director-digest" } }));
  });

  it("телефон клиента в тексте уведомления акционеру маскируется", async () => {
    await sendPushToAgent(shareholderId, { title: "Проверка", body: "Клиент +992900000001 ждёт", tag: `mask-${runId}` });
    const row = await waitFor(() => prisma.notification.findFirst({ where: { agentId: shareholderId, tag: `mask-${runId}` } }));
    expect(row?.body).not.toContain("900000001");
  });

  it("месячный финансовый PDF: круг владельца — учредитель, администратор с финансами; при ВЫКЛ — без учредителя", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { financePdfMonthlyEnabled: true, financePdfMonthlyLastSent: null } });
    const on = await sendMonthlyFinancePdf(new Date("2026-12-01T05:00:00Z"));
    expect(on.status).toBe("sent");
    const chats = sendDocumentFile.mock.calls.map((c) => c[0]);
    expect(chats).toContain(`81${String(runId).slice(-8)}`); // учредитель
    expect(chats).toContain(`83${String(runId).slice(-8)}`); // администратор с правом на финансы
    expect(chats).not.toContain(`84${String(runId).slice(-8)}`); // администратор, у которого финансы сняты
    expect(chats).not.toContain(`82${String(runId).slice(-8)}`); // агент без права на финансы
    expect(chats).not.toContain(`85${String(runId).slice(-8)}`); // РОП

    sendDocumentFile.mockClear();
    await setReports(false);
    await prisma.settings.update({ where: { id: "singleton" }, data: { financePdfMonthlyLastSent: null } });
    await sendMonthlyFinancePdf(new Date("2027-01-01T05:00:00Z"));
    expect(sendDocumentFile.mock.calls.map((c) => c[0])).not.toContain(`81${String(runId).slice(-8)}`);
  });

  it("круг автоматических PDF (findAutoPdfRecipients): директор, админ, учредитель — с правом и своим Telegram", async () => {
    await prisma.agent.update({ where: { id: directorId }, data: { telegramChatId: `86${String(runId).slice(-8)}` } });
    try {
      const got = (await findAutoPdfRecipients("finance.view")).map((r) => r.id);
      expect(got).toEqual(expect.arrayContaining([directorId, adminId, shareholderId]));
      expect(got).not.toContain(adminNoMoneyId); // финансы сняты галочкой
      expect(got).not.toContain(agentId);
      expect(got).not.toContain(ropId); // РОП не в круге, даже если право дадут
      await setReports(false);
      expect((await findAutoPdfRecipients("finance.view")).map((r) => r.id)).not.toContain(shareholderId);
    } finally {
      await prisma.agent.update({ where: { id: directorId }, data: { telegramChatId: null } });
    }
  });

  it("одна дверь автоматических PDF: файл, который сам собирает и шлёт PDF, берёт круг из findAutoPdfRecipients", () => {
    // Сторож (решение владельца 27.11.2026): новая рассылка PDF со своим списком ролей разошлась бы
    // с кругом владельца молча. «Себе по просьбе» (ownTelegram.ts) — не рассылка, у неё получатель один.
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "generated") walk(full); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const src = fs.readFileSync(full, "utf8");
        if (!src.includes("buildReportPdf(") || !src.includes("sendDocumentFile(")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (rel === "lib/reportPdf/ownTelegram.ts") continue;
        if (!src.includes("findAutoPdfRecipients(")) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("Шабнам и акционер: чтение — да, запись — нет", () => {
  async function shareholderActor(surface: "telegram-private" | "crm-private" = "telegram-private") {
    const access = await loadAgentAccess(shareholderId);
    expect(access).not.toBeNull();
    return { ...actorFromAccess(shareholderId, access!, surface), telegramChatId: `81${String(runId).slice(-8)}` };
  }

  it("ни один инструмент записи не объявляется акционеру (кроме своих уведомлений)", async () => {
    const actor = await shareholderActor();
    const declared = new Set(pluginDeclarations(actor, true, "telegram").map((d) => d.name));
    const writes = listAssistantToolPlugins().filter((p) => p.level !== "A");
    expect(writes.length).toBeGreaterThan(10);
    const leaked = writes.filter((p) => declared.has(p.name) && p.executor.readOnlyRoleAllowed !== true).map((p) => p.name);
    expect(leaked).toEqual([]);
    expect(declared.has("send_finance_report_pdf")).toBe(true);
    expect(declared.has("set_notification_pref")).toBe(true);
  });

  it("брокер отказывает акционеру в КАЖДОЙ записи, даже если инструмент забыл свой запрет", async () => {
    const writes = listAssistantToolPlugins().filter((p) => p.level !== "A" && p.executor.readOnlyRoleAllowed !== true);
    const notRefused: string[] = [];
    for (const p of writes) {
      for (const channel of p.executor.channels ?? ["crm"]) {
        try {
          await createPendingAssistantAction(
            { agentId: shareholderId, channel, telegramPrivate: true, telegramChatId: `81${String(runId).slice(-8)}`, can: () => true },
            p.name,
            {},
          );
          notRefused.push(`${p.name}/${channel}: создано`);
        } catch (err) {
          const code = err instanceof AssistantActionError ? err.code : String(err);
          if (code !== "READ_ONLY_ROLE") notRefused.push(`${p.name}/${channel}: ${code}`);
        }
      }
    }
    expect(notRefused).toEqual([]);
  });

  it("запись, названная моделью наугад, не исполняется (run)", async () => {
    const actor = await shareholderActor();
    const write = listAssistantToolPlugins().find((p) => p.level !== "A" && p.executor.readOnlyRoleAllowed !== true)!;
    expect(assistantPluginAllowed(write, actor)).toBe(false);
    const result = await runAssistantToolPlugin(write, {}, actor, { channel: "telegram" });
    expect(result).toMatchObject({ code: "READ_ONLY_ROLE" });
  });

  it("«пришли финансовый PDF»: файл уходит в свой чат, повтор в течение минуты — отказ", async () => {
    const actor = await shareholderActor();
    const tool = findAssistantToolPlugin("send_finance_report_pdf")!;
    expect(tool.level).toBe("A");
    const first = await runAssistantToolPlugin(tool, { month: "2026-11" }, actor, { channel: "telegram" });
    expect(first).toMatchObject({ ok: true });
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
    expect(sendDocumentFile.mock.calls[0][0]).toBe(`81${String(runId).slice(-8)}`);
    expect(buildReportPdf.mock.calls[0][1]).toEqual({ month: "2026-11" });

    const second = await runAssistantToolPlugin(tool, {}, actor, { channel: "telegram" });
    expect(second).toMatchObject({ error: expect.stringContaining("Повторить можно через") });
    expect(sendDocumentFile).toHaveBeenCalledTimes(1);
  });

  it("сбой сборки — честный отказ и запись в журнал ошибок, без выдумки", async () => {
    const actor = await shareholderActor();
    // Своё сообщение на прогон: журнал ошибок склеивает повторы одного текста.
    const marker = `render exploded ${runId}-${Math.random().toString(36).slice(2)}`;
    buildReportPdf.mockRejectedValueOnce(new Error(marker));
    const res = await runAssistantToolPlugin(findAssistantToolPlugin("send_finance_report_pdf")!, {}, actor, { channel: "telegram" });
    expect(res).toMatchObject({ error: "Не получилось собрать или отправить отчёт. Попробуйте позже" });
    expect(sendDocumentFile).not.toHaveBeenCalled();
    await waitFor(() => prisma.errorLog.findFirst({ where: { message: { contains: marker } } }));
  });

  it("PDF — действие, не чтение: в ходе «только прочитать» не объявляется (ревью #506)", async () => {
    const actor = await shareholderActor();
    const readOnlyTurn = pluginDeclarations(actor, false, "telegram", true).map((d) => d.name);
    expect(readOnlyTurn).not.toContain("send_finance_report_pdf");
    expect(findAssistantToolPlugin("send_finance_report_pdf")).toMatchObject({ sideEffect: "own" });
  });

  it("срок ответа истёк, пока собирался файл, — файл НЕ уходит молча (ревью #506)", async () => {
    const actor = await shareholderActor();
    const stopper = new AbortController();
    buildReportPdf.mockImplementationOnce(async () => {
      stopper.abort(new Error("deadline"));
      return { buffer: Buffer.from("%PDF"), filename: "f.pdf", periodLabel: "Ноябрь 2026", periodKey: "2026-11" };
    });
    const res = await runAssistantToolPlugin(findAssistantToolPlugin("send_finance_report_pdf")!, {}, actor, { channel: "telegram", signal: stopper.signal });
    expect(res).toMatchObject({ code: "ABORTED" });
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });

  it("тишина в группе (set_group_quiet) — запись, акционеру закрыта (ревью #506)", async () => {
    const access = await loadAgentAccess(shareholderId);
    const actor = { ...actorFromAccess(shareholderId, access!, "telegram-group"), groupChat: { chatId: "-100500", registeredAt: Date.now() } };
    const quiet = findAssistantToolPlugin("set_group_quiet")!;
    expect(assistantPluginAllowed(quiet, actor)).toBe(false);
    expect(await runAssistantToolPlugin(quiet, { minutes: 30 }, actor, { channel: "telegram" })).toMatchObject({ code: "READ_ONLY_ROLE" });
  });

  it("агенту без права на финансы инструмент не объявляется и не отдаёт файл", async () => {
    const access = await loadAgentAccess(agentId);
    const actor = actorFromAccess(agentId, access!, "telegram-private");
    expect(pluginDeclarations(actor, true, "telegram").map((d) => d.name)).not.toContain("send_finance_report_pdf");
    const res = await runAssistantToolPlugin(findAssistantToolPlugin("send_finance_report_pdf")!, {}, actor, { channel: "telegram" });
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(sendDocumentFile).not.toHaveBeenCalled();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * PDF-ОТЧЁТЫ (14.11.2026): файл получает только тот, кто видит сам отчёт;
 * каждая выгрузка — в журнале действий; Telegram — только свой чат;
 * месячная рассылка выключена по умолчанию и не уходит дважды за месяц.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { sendMonthlyFinancePdf, previousMonthKey } = await import("../src/lib/reportPdf/monthlyFinance.js");

const runId = Date.now();
const tail = String(runId).slice(-7);
const agentIds: string[] = [];
let agentToken = "";
let directorToken = "";
let directorId = "";
let securityToken = "";
let savedSettings: { financePdfMonthlyEnabled: boolean; financePdfMonthlyLastSent: string | null } | null = null;

/** supertest по умолчанию не собирает бинарное тело — забираем байты сами. */
function binary(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  const agent = await prisma.agent.create({ data: { fullName: `Агент PDF ${runId}`, phone: `+99291${tail}`, role: "AGENT", passwordHash: "x" } });
  const director = await prisma.agent.create({ data: { fullName: `Директор PDF ${runId}`, phone: `+99292${tail}`, role: "DIRECTOR", passwordHash: "x" } });
  const security = await prisma.agent.create({ data: { fullName: `СБ PDF ${runId}`, phone: `+99293${tail}`, role: "SECURITY", passwordHash: "x" } });
  agentIds.push(agent.id, director.id, security.id);
  directorId = director.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  securityToken = signAccessToken({ sub: security.id, role: "SECURITY" });
  savedSettings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { financePdfMonthlyEnabled: true, financePdfMonthlyLastSent: true } });
});

afterAll(async () => {
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("PDF-отчёты: права и журнал", () => {
  it("агент без права на финансы финансовый PDF не получает", async () => {
    const res = await request(app).get("/api/v1/report-pdf/finance").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("неизвестный отчёт — 404", async () => {
    const res = await request(app).get("/api/v1/report-pdf/salary").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(404);
  });

  it("будущий месяц и перевёрнутый период — 400, а не пустой отчёт", async () => {
    const future = await request(app).get("/api/v1/report-pdf/finance?month=2099-01").set("Authorization", `Bearer ${directorToken}`);
    expect(future.status).toBe(400);
    const reversed = await request(app).get("/api/v1/report-pdf/team?from=2026-11-10&to=2026-11-01").set("Authorization", `Bearer ${directorToken}`);
    expect(reversed.status).toBe(400);
  });

  it("директор получает финансовый PDF, выгрузка записана в журнал", async () => {
    const res = await request(app).get("/api/v1/report-pdf/finance?month=2026-10&months=3").set("Authorization", `Bearer ${directorToken}`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    await expect
      .poll(async () => prisma.auditLog.count({ where: { agentId: directorId, action: "REPORT_PDF_EXPORT", entityId: "finance" } }))
      .toBeGreaterThan(0);
  }, 60_000);

  it("служба безопасности (отчёты без финансов) получает PDF по команде", async () => {
    const res = await request(app).get("/api/v1/report-pdf/team?from=2026-11-01&to=2026-11-14").set("Authorization", `Bearer ${securityToken}`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("в Telegram без привязанного чата — понятный отказ, а не отправка куда-то ещё", async () => {
    const res = await request(app).post("/api/v1/report-pdf/finance/telegram").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(409);
  });
});

describe("Месячная рассылка финансового PDF", () => {
  it("выключена — ничего не делает", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { financePdfMonthlyEnabled: false, financePdfMonthlyLastSent: null } });
    const result = await sendMonthlyFinancePdf();
    expect(result.status).toBe("disabled");
  });

  it("уже разосланный месяц второй раз не уходит", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { financePdfMonthlyEnabled: true, financePdfMonthlyLastSent: previousMonthKey() } });
    const result = await sendMonthlyFinancePdf();
    expect(result.status).toBe("already-sent");
  });

  it("никому не дошло — месяц отпускается, следующий день повторит", async () => {
    // В тестах ключа бота нет: директорам с чатом отправка падает («failed»), без
    // чата — «no-recipients». В обоих случаях отметка месяца обязана сняться.
    await prisma.settings.update({ where: { id: "singleton" }, data: { financePdfMonthlyEnabled: true, financePdfMonthlyLastSent: null } });
    const first = await sendMonthlyFinancePdf();
    expect(first.month).toBe(previousMonthKey());
    expect(["no-recipients", "failed"]).toContain(first.status);
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { financePdfMonthlyLastSent: true } });
    expect(settings?.financePdfMonthlyLastSent).toBeNull();
  }, 60_000);

  it("React в проекте один: PDF на сервере и экраны на одной версии", async () => {
    // 14.11.2026: установка движка PDF подняла react до 19.3.1 при react-dom 19.3.0 —
    // веб падал белым экраном. Сторож: react и react-dom одной версии и для API, и для веба.
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const root = path.resolve(import.meta.dirname, "..", "..", "..");
    const version = (from: string, pkg: string) => {
      const req = createRequire(path.join(root, from, "package.json"));
      const file = req.resolve(`${pkg}/package.json`);
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
    };
    const apiReact = version("apps/api", "react");
    expect(version("apps/web", "react")).toBe(apiReact);
    expect(version("apps/web", "react-dom")).toBe(apiReact);
  });

  it("деньги с дирамами печатаются с дирамами", async () => {
    const { money } = await import("../src/lib/reportPdf/theme.js");
    expect(money(33.33)).toBe("33,33 с.");
    expect(money(1234567)).toBe("1 234 567 с.");
    expect(money(-2967.5)).toBe("−2 967,50 с.");
  });

  it("прошлый месяц считается по Душанбе, а не по UTC", () => {
    // 31 октября 20:00 UTC = 1 ноября 01:00 в Душанбе → прошлый месяц уже октябрь.
    expect(previousMonthKey(new Date("2026-10-31T20:00:00Z"))).toBe("2026-10");
    expect(previousMonthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12");
  });
});

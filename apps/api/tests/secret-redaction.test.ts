import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { logSystemError } from "../src/lib/systemError.js";
import { redactSecretsInText } from "../src/lib/secretRedaction.js";

/**
 * Секреты не попадают в журнал ошибок (26.11.2026, lib/secretRedaction.ts).
 * Значения ниже — выдуманные строки нужной формы, не настоящие ключи.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const run = String(Date.now()).slice(-7);
const FAKE = `FAKESECRET${run}abcdef`;
const created: string[] = [];

afterAll(async () => {
  await prisma.errorLog.deleteMany({ where: { message: { contains: run } } });
  await prisma.agent.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe("redactSecretsInText", () => {
  it.each([
    [`GET https://graph.facebook.com/v23.0/me?fields=id&access_token=${FAKE}`, `GET https://graph.facebook.com/v23.0/me?fields=id&access_token=***`],
    [`fetch https://graph.facebook.com/x?access_token=${FAKE}&limit=5 failed`, `fetch https://graph.facebook.com/x?access_token=***&limit=5 failed`],
    [`Authorization: Bearer ${FAKE}`, "Authorization: Bearer ***"],
    [`https://api.telegram.org/bot1234567:${FAKE}AAAA/sendMessage`, "https://api.telegram.org/bot***/sendMessage"],
    [`/uploads/video/a.mp4?t=${FAKE}`, "/uploads/video/a.mp4?t=***"],
    [`/api/v1/attachments/s/x.jpg?a=1&e=2&k=${FAKE}`, "/api/v1/attachments/s/x.jpg?a=1&e=2&k=***"],
    [`url?api_key=${FAKE}`, "url?api_key=***"],
    [`url?key=${FAKE}#frag`, "url?key=***#frag"],
    [`ответ {"access_token":"${FAKE}","token_type":"bearer"}`, `ответ {"access_token":"***","token_type":"bearer"}`],
    [`client_secret=${FAKE} token=${FAKE}`, "client_secret=*** token=***"],
  ])("маскирует %s", (input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected);
  });

  it.each([
    "Gemini 429: code=429 status=RESOURCE_EXHAUSTED",
    "Не удалось отправить сообщение клиенту №123: таймаут 8000 мс",
    "TypeError: Cannot read properties of undefined (reading 'token')",
    "monkey=12345 и keyboard=qwerty — не параметры секрета",
    "Bearer token missing",
    "https://crm.royalhome.tj/clients/42?tab=chat",
    "t=12 k=ab",
  ])("обычный текст не меняется: %s", (input) => {
    expect(redactSecretsInText(input)).toBe(input);
  });

  it("никогда не удлиняет запись и пропускает пустое", () => {
    const samples = ["k=abcd", "t=abcd&k=efgh", "Bearer abcdefgh", `x?access_token=${FAKE}`, "token=abc"];
    for (const s of samples) expect(redactSecretsInText(s).length).toBeLessThanOrEqual(s.length);
    expect(redactSecretsInText(undefined)).toBeUndefined();
    expect(redactSecretsInText(null)).toBeNull();
    expect(redactSecretsInText("")).toBe("");
  });
});

describe("двери журнала", () => {
  it("logSystemError чистит текст, адрес и стек", async () => {
    await logSystemError("api", `Сбой Graph ${run}: https://graph.facebook.com/x?access_token=${FAKE}`, {
      url: `https://graph.facebook.com/x?access_token=${FAKE}`,
      stack: `Error: Bearer ${FAKE}\n    at x`,
      dedupKey: `secret-redaction-${run}`,
    });
    const row = await prisma.errorLog.findFirst({ where: { message: { contains: run } }, orderBy: { createdAt: "desc" } });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(FAKE);
    expect(row!.message).toContain("access_token=***");
  });

  it("ошибка браузера POST /errors чистится той же дверью", async () => {
    const agent = await prisma.agent.create({ data: { fullName: `Журнал ${run}`, phone: `+99297${run}`, role: "AGENT" } });
    created.push(agent.id);
    const token = signAccessToken({ sub: agent.id, role: "AGENT" });
    const res = await request(app).post("/api/v1/errors").set("Authorization", `Bearer ${token}`).send({
      message: `Ошибка экрана ${run} при /uploads/a.mp4?t=${FAKE}`,
      stack: `at https://crm/x?k=${FAKE}`,
      url: `https://crm.royalhome.tj/l/abc?token=${FAKE}`,
    });
    expect(res.status).toBe(204);
    const row = await prisma.errorLog.findFirst({ where: { source: "web", message: { contains: run } } });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(FAKE);
  });

  it("сторож: каждый файл, пишущий в ErrorLog, зовёт redactSecretsInText", () => {
    const src = path.resolve(here, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "generated" || name === "node_modules") continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(name)) {
          const text = readFileSync(full, "utf8");
          if (/errorLog\.(create|createMany|upsert)\(/.test(text) && !text.includes("redactSecretsInText(")) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    };
    walk(src);
    expect(offenders, `Пишут в ErrorLog мимо маски секретов:\n${offenders.join("\n")}`).toEqual([]);
  });
});

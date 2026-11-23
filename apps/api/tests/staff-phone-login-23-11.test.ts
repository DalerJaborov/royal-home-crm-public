import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { normalizeStaffPhone, staffPhoneLookupForms, tajikNationalNumber } from "@royal-home/shared";

/**
 * НОМЕР СОТРУДНИКА — ОДНА ЗАПИСЬ `+992XXXXXXXXX` (23.11.2026). Двум новым сотрудникам
 * номер лёг девятью цифрами, «+992 97…» учётку не находил, СМС с кодом не уходила и
 * в журнал не писалось ничего. Держим: запись нормализуется, вход находит и уже
 * записанные кривые номера, занятый номер даёт понятную ошибку, а не дубль.
 */
const sent: { phone: string; text: string }[] = [];
vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  return {
    ...orig,
    sendSms: async (p: { phone: string; text: string }) => {
      sent.push(p);
      return { ok: true, id: "t", parts: 1 };
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { createStaffMember, updateStaffMember } = await import("../src/lib/staffAdmin.js");

const tail = String(Date.now()).slice(-7);
const national = `97${tail}`;
const legacyNational = `96${tail}`;
const zeroNational = `95${tail}`;
const ids: string[] = [];
let actor: { id: string; role: string; can: () => boolean };
let director: Awaited<ReturnType<typeof prisma.agent.create>>;

const askCode = (p: string) => request(app).post("/api/v1/auth/login/code").send({ phone: p });

beforeAll(async () => {
  director = await prisma.agent.create({ data: { fullName: "Директор номера", phone: `+99298${tail}`, role: "DIRECTOR" } });
  ids.push(director.id);
  actor = { id: director.id, role: "DIRECTOR", can: () => true };
});
beforeEach(() => {
  sent.length = 0;
});
afterAll(async () => {
  await prisma.loginSmsCode.deleteMany({ where: { agentId: { in: ids } } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("normalizeStaffPhone", () => {
  it("любая таджикская запись → +992XXXXXXXXX; иностранный как есть; мусор → null", () => {
    for (const raw of [national, `0${national}`, `992${national}`, `+992${national}`, `+992 97 ${tail.slice(0, 3)} ${tail.slice(3)}`]) {
      expect(normalizeStaffPhone(raw)).toBe(`+992${national}`);
    }
    expect(normalizeStaffPhone("+7 916 123 45 67")).toBe("+7 916 123 45 67");
    expect(normalizeStaffPhone("97123")).toBeNull();
    expect(normalizeStaffPhone("+99297123")).toBeNull();
    expect(normalizeStaffPhone("")).toBeNull();
    expect(staffPhoneLookupForms("+992 " + national)).toEqual(expect.arrayContaining([`+992${national}`, `992${national}`, national, `0${national}`]));
  });
});

describe("создание и правка сотрудника", () => {
  it("создание с 97… сохраняет +99297…", async () => {
    const out = await createStaffMember(actor, { fullName: "Новый Девять", phone: national, role: "AGENT" });
    expect(out.ok).toBe(true);
    const row = await prisma.agent.findFirstOrThrow({ where: { fullName: "Новый Девять", phone: { endsWith: national } } });
    ids.push(row.id);
    expect(row.phone).toBe(`+992${national}`);
  });

  it("неверный номер — 400 с понятным текстом; занятый в другой записи — 409, не дубль", async () => {
    const bad = await createStaffMember(actor, { fullName: "Обрывок Номер", phone: "97123", role: "AGENT" });
    expect(bad.ok).toBe(false);
    expect(bad).toMatchObject({ status: 400 });
    const dup = await createStaffMember(actor, { fullName: "Дубль Номер", phone: `0${national}`, role: "AGENT" });
    expect(dup).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.agent.count({ where: { phone: { endsWith: national } } })).toBe(1);
  });

  it("правка телефона сохраняет +992…; свой же номер в другой записи не конфликтует с собой", async () => {
    const other = await prisma.agent.create({ data: { fullName: "Правка Номер", phone: `+992944${tail}`, role: "AGENT" } });
    ids.push(other.id);
    const out = await updateStaffMember(actor, other.id, { phone: `0${zeroNational}` });
    expect(out.ok).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: other.id } })).phone).toBe(`+992${zeroNational}`);
    const clash = await updateStaffMember(actor, other.id, { phone: national });
    expect(clash).toMatchObject({ ok: false, status: 409 });
  });
});

describe("вход по СМС находит учётку при любой записи номера", () => {
  it("«+992 97…» находит учётку, записанную как 97…, и шлёт СМС", async () => {
    const legacy = await prisma.agent.create({ data: { fullName: "Кривой Номер", phone: legacyNational, role: "AGENT" } });
    ids.push(legacy.id);
    const res = await askCode(`+992 ${legacyNational.slice(0, 2)} ${legacyNational.slice(2)}`);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(tajikNationalNumber(sent[0].phone)).toBe(legacyNational);
  });

  it("запись с ведущим нулём и с 992 без плюса тоже находится", async () => {
    const zero = await prisma.agent.create({ data: { fullName: "Нулевой Номер", phone: `0${zeroNational}`, role: "AGENT" } });
    ids.push(zero.id);
    expect((await askCode(`+992${zeroNational}`)).status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(tajikNationalNumber(sent[0].phone)).toBe(zeroNational);
  });
});

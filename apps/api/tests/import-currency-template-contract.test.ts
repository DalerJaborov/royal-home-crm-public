import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { parseCsv } from "../src/lib/csv.js";

const marker = `Synthetic import contract ${randomUUID()}`;
const headers = ["Название", "Тип", "Комнаты", "Площадь", "Этаж", "Этажей всего", "Окна", "Цена", "Валюта", "Район", "Адрес", "Контакт владельца"];
let actorId: string;
let districtId: string;
let token: string;
let counter = 0;
const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const csv = (rows: string[][]) => rows.map((row) => row.map(quote).join(";")).join("\n");

beforeAll(async () => {
  actorId = (await prisma.agent.create({ data: {
    fullName: marker, phone: `test-import-contract-${randomUUID()}`, passwordHash: "test-unused", role: "ADMIN",
  } })).id;
  districtId = (await prisma.district.create({ data: { name: marker } })).id;
  token = signAccessToken({ sub: actorId, role: "ADMIN" });
});

afterAll(async () => {
  if (districtId) {
    await prisma.property.deleteMany({ where: { districtId } });
    await prisma.district.delete({ where: { id: districtId } });
  }
  if (actorId) await prisma.agent.delete({ where: { id: actorId } });
});

function propertyRow(currency: string) {
  counter++;
  return [`${marker} ${counter}`, "Квартира", "2", "64", "3", "9", "4", "50000", currency, marker,
    `Synthetic import address ${counter}`, "+992•••••0000"];
}

function upload(text: string) {
  return request(app).post("/api/v1/import/properties").set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(text), "synthetic-properties.csv");
}

describe("property import validates currencies before defaulting", () => {
  it.each(["RUB", "EUR", "USDD"])("rejects explicit unsupported currency %s without storing a property", async (currency) => {
    const row = propertyRow(currency);
    const response = await upload(csv([headers, row]));
    expect(response.status).toBe(200);
    expect(response.body.created).toBe(0);
    expect(response.body.skipped).toHaveLength(1);
    expect(response.body.skipped[0].error).toContain("Валюта");
    expect(await prisma.property.count({ where: { title: row[0], districtId } })).toBe(0);
  });

  it.each([["", "TJS"], ["  ", "TJS"], ["TJS", "TJS"], ["USD", "USD"], ["usd", "USD"]])(
    "preserves currency input %j as %s", async (currency, expected) => {
      const row = propertyRow(currency);
      const response = await upload(csv([headers, row]));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ created: 1, skipped: [] });
      const stored = await prisma.property.findFirstOrThrow({ where: { title: row[0], districtId } });
      expect(stored.currency).toBe(expected);
      expect(Number(stored.price)).toBe(50000);
    },
  );
});

it("imports the downloaded property template after replacing only synthetic identity fields", async () => {
  const template = await request(app).get("/api/v1/import/properties/template").set("Authorization", `Bearer ${token}`);
  expect(template.status).toBe(200);
  const [templateHeaders, example] = parseCsv(template.text);
  counter++;
  example[templateHeaders.indexOf("Название")] = `${marker} ${counter}`;
  example[templateHeaders.indexOf("Район")] = marker;
  example[templateHeaders.indexOf("Контакт владельца")] = "+992•••••0000";
  const response = await upload(csv([templateHeaders, example]));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ created: 1, skipped: [] });
  expect(templateHeaders).toContain("Окна");
  const stored = await prisma.property.findFirstOrThrow({ where: { title: example[0], districtId } });
  expect(stored.windowCount).toBe(Number(example[templateHeaders.indexOf("Окна")]));
});

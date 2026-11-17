import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";

/**
 * Вектор подбора Property.embedding (58 % строки объекта) скрыт по умолчанию — глобальный
 * omit в src/db.ts (17.11.2026, аудит скорости P1). Здесь:
 *  1) в работе: обычные чтения, в том числе внутри интерактивной транзакции, вектор НЕ везут,
 *     а явный select его отдаёт;
 *  2) сторож: читать `.embedding` в коде можно только там, где вектор запрошен явно. У `tx`
 *     внутри $transaction Prisma теряет omit в ТИПАХ, компилятор такое чтение не поймает —
 *     а в работе оно вернёт undefined.
 */

const runId = `${Date.now()}`.slice(-8);
let agentId = "";
let districtId = "";
let propertyId = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент вектора ${runId}`, phone: `+99297${runId.slice(-7)}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 4) },
  });
  agentId = agent.id;
  districtId = (await prisma.district.create({ data: { name: `Район вектора ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект вектора ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100000,
        currency: "TJS",
        districtId,
        address: "Тестовая вектора, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        createdById: agentId,
        assignedAgentId: agentId,
        embedding: [1, 0, 0],
        embeddingUpdatedAt: new Date(),
      },
    })
  ).id;
});

afterAll(async () => {
  if (propertyId) await prisma.property.delete({ where: { id: propertyId } });
  if (districtId) await prisma.district.delete({ where: { id: districtId } });
  if (agentId) await prisma.agent.delete({ where: { id: agentId } });
});

describe("Property.embedding скрыт по умолчанию", () => {
  it("findUnique и findMany без select вектор не везут", async () => {
    const one = await prisma.property.findUnique({ where: { id: propertyId } });
    expect(one).not.toBeNull();
    expect(one).not.toHaveProperty("embedding");
    const many = await prisma.property.findMany({ where: { id: propertyId }, include: { district: true } });
    expect(many[0]).not.toHaveProperty("embedding");
  });

  it("внутри интерактивной транзакции — тоже не везут", async () => {
    const row = await prisma.$transaction(async (tx) => tx.property.findUnique({ where: { id: propertyId } }));
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("embedding");
  });

  it("явный select и omit:false вектор отдают", async () => {
    const picked = await prisma.property.findUnique({ where: { id: propertyId }, select: { embedding: true } });
    expect(picked?.embedding).toEqual([1, 0, 0]);
    const full = await prisma.property.findUnique({ where: { id: propertyId }, omit: { embedding: false } });
    expect(full?.embedding).toEqual([1, 0, 0]);
  });
});

describe("сторож: `.embedding` читают только там, где вектор запрошен явно", () => {
  /** Файл → почему там можно. Новое место — сюда, с причиной и явным select. */
  const ALLOWED: Record<string, string> = {
    "lib/embeddingSearch.ts": "select: { id: true, embedding: true }",
    "ai/embeddings.ts": "ответ Gemini API (data.embedding.values), не строка объекта",
    "ai/assistant/knowledgeSemantic.ts": "сырой SQL по AssistantKnowledgeEmbedding, не Property",
    "ai/assistant.ts": "hooks.embedding — настройки запроса к Gemini (EmbeddingRequestOptions), не строка объекта",
  };
  const srcRoot = path.resolve(__dirname, "../src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("нет чтений .embedding вне списка", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const rel = path.relative(srcRoot, file).replace(/\\/g, "/");
      if (ALLOWED[rel]) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return;
          if (/\.embedding\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("список не пустеет молча: в разрешённых файлах чтение действительно есть", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const text = fs.readFileSync(path.join(srcRoot, rel), "utf8");
      expect(/\.embedding\b/.test(text), rel).toBe(true);
    }
  });
});

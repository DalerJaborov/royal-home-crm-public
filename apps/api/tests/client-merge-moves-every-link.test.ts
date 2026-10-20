import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * СЛИЯНИЕ КАРТОЧЕК ПЕРЕНОСИТ ВСЕ ССЫЛКИ НА КЛИЕНТА (аудит 23.09.2026, №32).
 *
 * Объекты продавца, досье, вопросы собственнику оставались у дубля, который
 * уходит в Корзину: у основной карточки продавца «нет объекта». Первый тест
 * читает schema.prisma и требует, чтобы КАЖДАЯ ссылка на клиента была либо в
 * списке переносимых, либо в списке оставляемых с причиной — новая таблица не
 * проскочит молча.
 */

const { prisma } = await import("../src/db.js");
const { mergeClients, MERGE_LINKS_MOVED, MERGE_LINKS_LEFT_BEHIND } = await import("../src/lib/clientMerge.js");

function clientLinksInSchema(): string[] {
  const schema = readFileSync(fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const links = new Set<string>();
  for (const m of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
    const [, model, body] = m;
    for (const rel of body.matchAll(/\s\w+\s+Client\??\s+@relation\([^)]*fields:\s*\[(\w+)\]/g)) links.add(`${model}.${rel[1]}`);
    // Ссылки без объявленной связи — просто поле с id клиента. После типа —
    // пробел ИЛИ конец строки (B9, 02.10.2026): поле без комментария в конце
    // строки (`clientId        String`) прежний шаблон `[ \t]` пропускал, и
    // WhatsAppFirstContact.clientId выпал из сверки. Просмотр вперёд, а не
    // захват: съеденный перевод строки спрятал бы следующее поле.
    for (const f of body.matchAll(/\n\s+(\w*[cC]lientId)\s+String\??(?=[ \t\r\n])/g)) {
      // OAuth-идентификаторы внешних сервисов, не ссылки на клиента CRM.
      if (f[1] === "youtubeClientId" || f[1] === "yandexWebmasterClientId") continue;
      links.add(`${model}.${f[1]}`);
    }
  }
  return [...links].sort();
}

describe("Список переносимых при слиянии ссылок сверен со схемой", () => {
  it("каждая ссылка на клиента либо переносится, либо оставлена с причиной", () => {
    const known = new Set<string>([...MERGE_LINKS_MOVED, ...Object.keys(MERGE_LINKS_LEFT_BEHIND)]);
    const missing = clientLinksInSchema().filter((l) => !known.has(l));
    expect(missing).toEqual([]);
  });
});

const runId = Date.now();
const clientIds: string[] = [];
let agentId = "";
let districtId = "";
let propertyId = "";

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.jobApplication.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.whatsAppFirstContact.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.contactProfile.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  if (agentId) await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Слияние двух карточек продавца", () => {
  it("объект, бронь и досье дубля переезжают к основной карточке", async () => {
    const tail = String(runId).slice(-7);
    agentId = (
      await prisma.agent.create({ data: { fullName: `Агент слияния ${runId}`, phone: `+99295${tail}`, role: "AGENT", passwordHash: "x" } })
    ).id;
    districtId = (await prisma.district.create({ data: { name: `Район слияния ${runId}` } })).id;
    for (const p of [`+99293${tail}`, `+99294${tail}`]) await prisma.client.deleteMany({ where: { phone: p } });
    const primary = await prisma.client.create({
      data: { fullName: `Продавец ${runId}`, phone: `+99293${tail}`, source: "INSTAGRAM", kind: "SELLER", assignedAgentId: agentId },
    });
    const duplicate = await prisma.client.create({
      data: { fullName: `Продавец дубль ${runId}`, phone: `+99294${tail}`, source: "INSTAGRAM", kind: "SELLER", assignedAgentId: agentId },
    });
    clientIds.push(primary.id, duplicate.id);
    propertyId = (
      await prisma.property.create({
        data: {
          title: `Объект слияния ${runId}`,
          type: "APARTMENT",
          areaSqm: 50,
          price: 40000,
          currency: "TJS",
          districtId,
          address: "Тестовая слияния, 1",
          condition: "GOOD",
          status: "AVAILABLE",
          assignedAgentId: agentId,
          sellerClientId: duplicate.id,
          reservedForClientId: duplicate.id,
        } as never,
      })
    ).id;
    const profile = await prisma.contactProfile.create({ data: { clientId: duplicate.id } as never });
    const jobApplication = await prisma.jobApplication.create({
      data: { clientId: duplicate.id, channel: "WHATSAPP", rawText: "тест: анкета дубля" } as never,
    });

    const waFirst = await prisma.whatsAppFirstContact.create({
      data: { clientId: duplicate.id, agentId, recipient: `99294${tail}`, templateName: "тест" },
    });

    await mergeClients(primary.id, duplicate.id, agentId, "тест: слияние продавцов");

    const property = await prisma.property.findUniqueOrThrow({ where: { id: propertyId } });
    expect(property.sellerClientId).toBe(primary.id);
    expect(property.reservedForClientId).toBe(primary.id);
    const movedProfile = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(movedProfile.clientId).toBe(primary.id);
    const movedApplication = await prisma.jobApplication.findUniqueOrThrow({ where: { id: jobApplication.id } });
    expect(movedApplication.clientId).toBe(primary.id);
    const movedWa = await prisma.whatsAppFirstContact.findUniqueOrThrow({ where: { id: waFirst.id } });
    expect(movedWa.clientId).toBe(primary.id);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import {
  findAgentByInstagramPost,
  instagramPostCode,
  instagramPostCodesIn,
} from "../src/lib/instagramPostLead.js";

/**
 * Клиент прислал ссылку на пост — лид уходит агенту этого объекта
 * (владелец 09.09.2026).
 *
 * Главное здесь — сравнение по КОДУ ПОСТА, а не по строке целиком. Один и тот же
 * пост приходит десятком разных ссылок: с www и без, /reel/ и /p/, с хвостом
 * ?igsh=... от кнопки «Поделиться», со слешем и без. Сравнение строк не сработало
 * бы почти никогда — то есть правило было бы, но не срабатывало.
 */

const runId = Date.now();
let agentId: string;
let districtId: string;
const propertyIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент поста", phone: `+992951${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район-пост-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeProperty(instagramUrl: string | null, status: "AVAILABLE" | "SOLD" = "AVAILABLE") {
  const p = await prisma.property.create({
    data: {
      title: `Объект поста ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 65000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      status,
      instagramUrl,
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(p.id);
  return p;
}

describe("Разбор ссылки", () => {
  it("код поста достаётся из /p/, /reel/, /reels/ и /tv/", () => {
    expect(instagramPostCode("https://www.instagram.com/p/ABC123xyz/")).toBe("ABC123xyz");
    expect(instagramPostCode("https://instagram.com/reel/ABC123xyz")).toBe("ABC123xyz");
    expect(instagramPostCode("https://www.instagram.com/reels/ABC123xyz/")).toBe("ABC123xyz");
    expect(instagramPostCode("https://instagram.com/tv/ABC123xyz/")).toBe("ABC123xyz");
  });

  it("аккаунт в пути не мешает — royalhome/reel/<код>", () => {
    expect(instagramPostCode("https://www.instagram.com/royalhome.tj/reel/ABC123xyz/")).toBe("ABC123xyz");
  });

  it("хвост от кнопки «Поделиться» отбрасывается", () => {
    expect(instagramPostCode("https://www.instagram.com/p/ABC123xyz/?igsh=MzRlODBiNWFlZA==")).toBe("ABC123xyz");
  });

  it("ссылка не на Instagram — кода нет", () => {
    expect(instagramPostCode("https://royalhome.tj/property/128")).toBeNull();
  });

  it("код находится в тексте сообщения, а не только в голой ссылке", () => {
    const text = "Здравствуйте! Интересует вот эта https://www.instagram.com/p/ABC123xyz/ — ещё продаётся?";
    expect(instagramPostCodesIn(text)).toEqual(["ABC123xyz"]);
  });
});

describe("Поиск объекта по ссылке", () => {
  it("ссылка совпала — возвращаем агента объекта", async () => {
    const p = await makeProperty("https://www.instagram.com/p/PostAAA111/");
    const match = await findAgentByInstagramPost("вот эта квартира https://instagram.com/reel/PostAAA111?igsh=xx");
    expect(match?.propertyId).toBe(p.id);
    expect(match?.agentId).toBe(agentId);
  });

  it("формы ссылки разные — объект тот же", async () => {
    const p = await makeProperty("https://www.instagram.com/reel/PostBBB222/");
    const match = await findAgentByInstagramPost("https://www.instagram.com/p/PostBBB222/");
    expect(match?.propertyId).toBe(p.id);
  });

  /** Пост проданного объекта висит в ленте — лид его агенту отдавать не за что. */
  it("объект продан — правило не срабатывает", async () => {
    await makeProperty("https://www.instagram.com/p/PostCCC333/", "SOLD");
    expect(await findAgentByInstagramPost("https://www.instagram.com/p/PostCCC333/")).toBeNull();
  });

  it("такого поста у нас нет — ничего не находим", async () => {
    expect(await findAgentByInstagramPost("https://www.instagram.com/p/NoSuchPost99/")).toBeNull();
  });

  it("ссылок в тексте нет вовсе — сразу null, в базу не ходим", async () => {
    expect(await findAgentByInstagramPost("Хочу двушку в Сино до 60 тысяч")).toBeNull();
  });
});

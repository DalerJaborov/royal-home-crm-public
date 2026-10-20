import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { sharedMediaHint } from "../src/messengers/sharedMedia.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * «Интерес клиента к объекту» → лид агенту-владельцу (владелец 21.08.2026:
 * «если кто-то пишет именно по объекту — отправляешь первым делом самому
 * агенту, он свои объекты лучше всех знает»).
 *
 * Три правила этого файла:
 *  1) пересланный пост/ссылка/номер словами пишет PropertyExposure(kind=
 *     CLIENT_SHARED) — тот же журнал, что читает leads.ts::pickByShownProperty
 *     для own_property_shown, значит маршрутизация работает без отдельного кода;
 *  2) без слова-контекста рядом с «№N» в СВОБОДНОМ тексте клиента запись НЕ
 *     пишется (адверсариальная проверка 21.08.2026 — риск случайного совпадения);
 *  3) повтор в пределах 10 минут не плодит вторую запись.
 */

const runId = Date.now().toString(36);

let districtId: string;
let agentId: string;
let propertyId: string;
let propertyShortId: number;
let instagram: CustomerMessengerFixture;

/**
 * recordClientInterest (sharedMedia.ts) пишет журнал через `void` — намеренно
 * не блокирует ответ клиенту ради строки в PropertyExposure. Тест поэтому
 * дожидается записи опросом, а не проверяет базу сразу после await sharedMediaHint —
 * тот же приём, что и waitForSummary в tests/call-continuation.test.ts.
 */
async function waitForExposure(where: { channel: string; recipientId: string; propertyId: string }, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await prisma.propertyExposure.findFirst({ where: { ...where, kind: "CLIENT_SHARED" } });
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  districtId = (await prisma.district.create({ data: { name: `Тест-район-интерес-${runId}` } })).id;
  const passwordHash = await bcrypt.hash("x", 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент интереса", phone: `+992965${runId}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const property = await prisma.property.create({
    data: {
      title: `Тест-объект-интерес-${runId}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 55,
      price: 45000,
      currency: "USD",
      districtId,
      address: "Тестовая, 9",
      condition: "GOOD",
      intakeAgentId: agentId,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;
});

afterAll(async () => {
  await prisma.propertyExposure.deleteMany({ where: { propertyId } });
  await instagram?.dispose();
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("клиент называет номер объекта словами", () => {
  it("с контекстом («квартира №N») — узнаётся и пишет интерес", async () => {
    const channel = "INSTAGRAM";
    const recipientId = `client-ctx-${runId}`;
    const hint = await sharedMediaHint({
      text: `Здравствуйте, интересует квартира №${propertyShortId}, ещё продаётся?`,
      channel,
      recipientId,
      transport: instagram.transport,
    });
    expect(hint).toContain(`№${propertyShortId}`);

    const exposure = await waitForExposure({ channel, recipientId, propertyId });
    expect(exposure).not.toBeNull();
    expect(exposure?.endpointScopeId).toBe(instagram.transport.endpointScopeId);
  });

  it("без контекста («заказ №N») — НЕ узнаётся, интерес не пишется", async () => {
    const channel = "INSTAGRAM";
    const recipientId = `client-noctx-${runId}`;
    const hint = await sharedMediaHint({
      text: `Добрый день, у меня заказ №${propertyShortId} с прошлой недели, когда доставка?`,
      channel,
      recipientId,
      transport: instagram.transport,
    });
    expect(hint).toBe("");

    // Отрицательный случай нечем дождаться — просто проверяем, что запись не
    // появилась за то же разумное время, что положительный тест ждёт появления.
    await new Promise((r) => setTimeout(r, 200));
    const exposure = await prisma.propertyExposure.findFirst({
      where: { channel, recipientId, propertyId, kind: "CLIENT_SHARED" },
    });
    expect(exposure).toBeNull();
  });

  it("повтор в пределах 10 минут не плодит вторую запись", async () => {
    const channel = "INSTAGRAM";
    const recipientId = `client-dup-${runId}`;
    const text = `квартира №${propertyShortId}, актуально?`;
    await sharedMediaHint({ text, channel, recipientId, transport: instagram.transport });
    expect(await waitForExposure({ channel, recipientId, propertyId })).not.toBeNull();
    await sharedMediaHint({ text, channel, recipientId, transport: instagram.transport });
    await new Promise((r) => setTimeout(r, 200));

    const count = await prisma.propertyExposure.count({
      where: { channel, recipientId, propertyId, kind: "CLIENT_SHARED" },
    });
    expect(count).toBe(1);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * АУДИТ CODEX 04.10.2026, PUB04: ошибка канала повторного показа не уводила
 * задание в повтор. publishPropertyRepost сама ловит отказы каналов, пишет FAILED
 * и возвращает ok=some(r.ok), поэтому при упавшем Instagram и вышедшем Telegram
 * (и даже при всех упавших) задание завершалось DONE, лестница maxAttempts/backoff
 * не применялась. Тот же приём, что у jobs/photoPostPublish.ts (Ф5 аудита 02.10).
 */

const publishMock = vi.fn();
vi.mock("../src/lib/socialReposts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/socialReposts.js")>();
  return { ...real, publishPropertyRepost: (...args: unknown[]) => publishMock(...args) };
});
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

const { prisma } = await import("../src/db.js");
const { socialRepostPublishJob } = await import("../src/jobs/socialRepostPublish.js");

const runId = Date.now().toString(36);
let districtId: string;
const propertyIds: string[] = [];

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Повтор ретрай ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 7",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-повтор-ретрай-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.propertySocialRepost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("повторный показ: отказ канала уводит задание в повтор", () => {
  it("Instagram получил 503, Telegram вышел — задание бросает, чтобы сработали maxAttempts и backoff", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({
      ok: true,
      results: { INSTAGRAM: { ok: false, error: "HTTP 503" }, TELEGRAM: { ok: true } },
    });
    await expect(socialRepostPublishJob.run({ propertyId: p.id, round: 1 })).rejects.toThrow(/Instagram/);
  });

  it("все каналы упали по сети (ok:false без reason) — тоже повтор", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({
      ok: false,
      results: { INSTAGRAM: { ok: false, error: "HTTP 503" }, FACEBOOK: { ok: false, error: "timeout" }, TELEGRAM: { ok: false, error: "429" } },
    });
    await expect(socialRepostPublishJob.run({ propertyId: p.id, round: 1 })).rejects.toThrow(/Instagram.*Facebook.*Telegram/);
  });

  it("отказ из-за настройки (канал не подключён) повтором не лечится — задание завершается", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({
      ok: true,
      results: { INSTAGRAM: { ok: false, error: "Instagram не подключён в Настройках" }, TELEGRAM: { ok: true } },
    });
    await expect(socialRepostPublishJob.run({ propertyId: p.id, round: 1 })).resolves.toBeUndefined();
  });

  it("все каналы вышли — задание завершается без повтора", async () => {
    const p = await makeProperty();
    publishMock.mockResolvedValueOnce({ ok: true, results: { INSTAGRAM: { ok: true }, FACEBOOK: { ok: true }, TELEGRAM: { ok: true } } });
    await expect(socialRepostPublishJob.run({ propertyId: p.id, round: 1 })).resolves.toBeUndefined();
  });

  it("публикация не запустилась (reason) — SCHEDULED круга закрыты, повтора нет", async () => {
    const p = await makeProperty();
    await prisma.propertySocialRepost.createMany({
      data: ["INSTAGRAM", "FACEBOOK", "TELEGRAM"].map((channel) => ({ propertyId: p.id, round: 1, hook: "тест", channel, status: "SCHEDULED", scheduledAt: new Date() })),
    });
    publishMock.mockResolvedValueOnce({ ok: false, results: {}, reason: "Объект не в продаже (или закрытый) — повтор не нужен" });
    await expect(socialRepostPublishJob.run({ propertyId: p.id, round: 1 })).resolves.toBeUndefined();
    expect(await prisma.propertySocialRepost.count({ where: { propertyId: p.id, status: "SCHEDULED" } })).toBe(0);
  });
});

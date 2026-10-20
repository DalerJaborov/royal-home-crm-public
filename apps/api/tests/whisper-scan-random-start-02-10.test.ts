import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * E12 глубокой проверки 02.10.2026: курсор обхода карточек для «шёпота» живёт
 * в памяти worker, а worker перезапускается на каждом выкате. Каждый новый
 * процесс начинал обход с начала базы — при двух десятках выкатов в день
 * карточки в конце порядка id до окна почти не доходили.
 *
 * Новый процесс начинает со случайной точки; круг замыкается как прежде.
 */

const { prisma } = await import("../src/db.js");
const { syncWhispers } = await import("../src/lib/telephony/whisperSync.js");

let before: { callWhisperEnabled: boolean; callWhisperIncoming: boolean } | null = null;

beforeAll(async () => {
  before = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { callWhisperEnabled: true, callWhisperIncoming: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { callWhisperEnabled: true, callWhisperIncoming: true } });
});

afterAll(async () => {
  if (before) await prisma.settings.update({ where: { id: "singleton" }, data: before });
  await prisma.$disconnect();
});

describe("обход «шёпота» после перезапуска процесса", () => {
  it("первый проход нового процесса начинается не с начала базы", async () => {
    const findMany = vi.spyOn(prisma.client, "findMany").mockResolvedValue([] as never);
    await syncWhispers();
    const first = findMany.mock.calls[0]?.[0] as { where?: { id?: { gt?: string } } } | undefined;
    expect(first?.where?.id?.gt).toMatch(/^[0-9a-f-]{36}$/);
    // Точка старта пришлась за последний id — круг начинается заново с начала.
    const second = findMany.mock.calls[1]?.[0] as { where?: { id?: unknown } } | undefined;
    expect(second?.where?.id).toBeUndefined();
    findMany.mockRestore();
  });
});

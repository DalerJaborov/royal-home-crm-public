import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { DEFAULT_EVENT_POINTS, EVENT_LABELS, CATEGORY_OF, buildEventPointsGuide } from "../src/lib/scoreJournal.js";

/**
 * Справочник «Как считаются баллы» (владелец 03.09.2026): агент должен видеть
 * прямо в CRM, за что какой плюс/минус, а не с чужих слов. Проверяем, что
 * справочник — не отдельная копия чисел, а честное отражение того, чем реально
 * считается счёт (loadEventPoints), включая правку директора в Settings.
 */

let savedPoints: unknown;

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { royalScoreEventPoints: true } });
  savedPoints = s?.royalScoreEventPoints ?? null;
});

afterEach(async () => {
  await prisma.settings.update({ where: { id: "singleton" }, data: { royalScoreEventPoints: savedPoints as object | null } });
});

describe("buildEventPointsGuide", () => {
  it("покрывает каждое событие из CATEGORY_OF, с подписью и текущей ценой по умолчанию", async () => {
    const guide = await buildEventPointsGuide();
    const byKind = new Map(guide.map((r) => [r.kind, r]));

    for (const kind of Object.keys(CATEGORY_OF)) {
      const row = byKind.get(kind);
      expect(row, `нет строки для ${kind}`).toBeDefined();
      expect(row!.category).toBe(CATEGORY_OF[kind as keyof typeof CATEGORY_OF]);
      expect(row!.label).toBe(EVENT_LABELS[kind as keyof typeof EVENT_LABELS] ?? kind);
      expect(row!.points).toBe(DEFAULT_EVENT_POINTS[kind as keyof typeof DEFAULT_EVENT_POINTS]);
    }
  });

  it("отражает правку директора из Settings, а не зашитое число", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { royalScoreEventPoints: { deal_closed: 42 } },
    });
    const guide = await buildEventPointsGuide();
    const row = guide.find((r) => r.kind === "deal_closed");
    expect(row?.points).toBe(42);
  });

  it("сделка закрыта — самое дорогое положительное событие по умолчанию", async () => {
    const guide = await buildEventPointsGuide();
    const positives = guide.filter((r) => r.points > 0);
    const max = Math.max(...positives.map((r) => r.points));
    expect(guide.find((r) => r.kind === "deal_closed")?.points).toBe(max);
  });

  it("новые события за возврат из светофора — в категории «дисциплина»", async () => {
    const guide = await buildEventPointsGuide();
    expect(guide.find((r) => r.kind === "client_revived_from_red")).toMatchObject({ category: "discipline", points: 2 });
    expect(guide.find((r) => r.kind === "client_revived_from_yellow")).toMatchObject({ category: "discipline", points: 1 });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { runNightlyGeoMatchSweepTick } from "../src/lib/geoMatchSweep.js";

/**
 * НОЧНОЙ ПРОХОД ГЕО-ПОДБОРА — страховка событийного подбора (12.09.2026).
 *
 * До 25.09.2026 до этого файла не дотягивался ни один тест. Он ставит задания в
 * общую очередь раз в сутки, без человека: сломается — подбор просто перестанет
 * находить совпадения «клиент захотел район ПОСЛЕ того, как объект встал в
 * продажу», и никто этого не заметит, потому что ничего не падает.
 *
 * ДАТА ПРОГОНА ВЗЯТА ЗАВЕДОМО ЧУЖАЯ (2031 год). Ключ дедупликации задания —
 * `geo-match-sweep:<день по Душанбе>:<объект>`, то есть общий на всю базу. С
 * настоящим «сегодня» этот файл делил бы ключи с соседями по прогону: чужая
 * запись мешала бы считать, а уборка за собой сносила бы чужое. С датой из
 * 2031-го ключи заведомо ничьи, и убрать их за собой можно по префиксу.
 *
 * Проверяется судьба СВОИХ объектов, а не счётчик прохода: в базе есть и чужие
 * объекты в продаже, они тоже попадают в выборку, и это правильно.
 */

const runId = Date.now();
// 06:00 UTC = 11:00 по Душанбе того же дня.
const MORNING = new Date("2031-03-17T06:00:00.000Z");
// 20:00 UTC = 01:00 по Душанбе УЖЕ СЛЕДУЮЩЕГО дня: смена суток здесь, а не в
// полночь UTC, иначе ночной проход дважды за сутки брал бы один и тот же ключ.
const LATE_UTC_SAME_DAY = new Date("2031-03-17T20:00:00.000Z");
const DAY_MORNING = "2031-03-17";
const DAY_AFTER_SHIFT = "2031-03-18";

const propertyIds: string[] = [];
let districtId = "";
let availableId = "";
let soldId = "";
let deletedId = "";

async function makeProperty(status: string, deleted = false) {
  const p = await prisma.property.create({
    data: {
      title: `Объект геопрохода ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 111000,
      currency: "TJS",
      districtId,
      address: "Тестовая, геопроход",
      condition: "GOOD",
      status,
      ...(deleted ? { deletedAt: new Date() } : {}),
    },
  });
  propertyIds.push(p.id);
  return p.id;
}

function jobsFor(propertyId: string, dayKey: string) {
  return prisma.backgroundJob.count({
    where: { type: "geo-match-sweep", dedupeKey: `geo-match-sweep:${dayKey}:${propertyId}` },
  });
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-геопроход-${runId}` } })).id;
  availableId = await makeProperty("AVAILABLE");
  soldId = await makeProperty("SOLD");
  deletedId = await makeProperty("AVAILABLE", true);
});

afterAll(async () => {
  // Только свои ключи: ни один соседний тест не работает с 2031 годом.
  await prisma.backgroundJob.deleteMany({
    where: {
      type: "geo-match-sweep",
      OR: [
        { dedupeKey: { startsWith: `geo-match-sweep:${DAY_MORNING}:` } },
        { dedupeKey: { startsWith: `geo-match-sweep:${DAY_AFTER_SHIFT}:` } },
      ],
    },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Ночной проход гео-подбора", () => {
  it("ставит задание объекту в продаже и не ставит проданному и удалённому", async () => {
    const result = await runNightlyGeoMatchSweepTick(MORNING);
    expect(result.candidates).toBeGreaterThanOrEqual(1);

    expect(await jobsFor(availableId, DAY_MORNING)).toBe(1);
    expect(await jobsFor(soldId, DAY_MORNING)).toBe(0);
    expect(await jobsFor(deletedId, DAY_MORNING)).toBe(0);
  });

  it("повторный проход в тот же день не заводит второе задание", async () => {
    await runNightlyGeoMatchSweepTick(MORNING);
    expect(await jobsFor(availableId, DAY_MORNING)).toBe(1);
  });

  it("сутки считаются по Душанбе: 20:00 UTC — это уже следующий день", async () => {
    // Тот же календарный день по UTC, но по Душанбе (UTC+5) уже следующий, значит
    // ключ другой и задание ставится заново. Если бы день считался по UTC, эта
    // проверка нашла бы ноль.
    await runNightlyGeoMatchSweepTick(LATE_UTC_SAME_DAY);
    expect(await jobsFor(availableId, DAY_AFTER_SHIFT)).toBe(1);
    expect(await jobsFor(availableId, DAY_MORNING)).toBe(1);
  });

  it("в задании лежит объект и день, а не пустая заготовка", async () => {
    const job = await prisma.backgroundJob.findFirst({
      where: { dedupeKey: `geo-match-sweep:${DAY_MORNING}:${availableId}` },
      select: { type: true, payload: true, maxAttempts: true },
    });
    expect(job).toBeTruthy();
    expect(job?.type).toBe("geo-match-sweep");
    expect(job?.payload).toMatchObject({ propertyId: availableId, dayKey: DAY_MORNING });
    // Пять попыток: ночная страховка не должна сдаваться с первого отказа.
    expect(job?.maxAttempts).toBe(5);
  });
});

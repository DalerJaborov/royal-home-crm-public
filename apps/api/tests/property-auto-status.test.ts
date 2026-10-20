import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./helpers/waitFor.js";
import { prisma } from "../src/db.js";
import {
  decidePropertyStatus,
  refreshPropertyStatus,
} from "../src/lib/propertyAutoStatus.js";

type Facts = Parameters<typeof decidePropertyStatus>[1];

/**
 * Автоматические статусы объекта (решение владельца 08.08.2026 — статусы должны
 * ставиться сами и у клиентов, и у объектов).
 *
 * Сначала проверяется чистая функция решения: какие факты к какому статусу ведут
 * и, главное, чего автоматика делать НЕ должна. Затем — применение на живой базе:
 * решение может быть верным, а запись всё равно не той (потерянный reservedAt,
 * задвоенная цена продажи).
 */

const facts = (over: Partial<Facts> = {}): Facts => ({
  dealCompleted: false,
  dealActive: false,
  sellerLost: false,
  // По умолчанию — просроченная бронь: так тесты, не упомянувшие срок явно,
  // проверяют тот же случай, что и раньше (13.08.2026 добавлен грайс-период,
  // см. отдельный блок ниже про свежий резерв).
  reservationExpired: true,
  ...over,
});

describe("Автостатус объекта: что он ставит", () => {
  it("завершённая сделка — «Продано»", () => {
    expect(
      decidePropertyStatus("RESERVED", facts({ dealCompleted: true }))?.next,
    ).toBe("SOLD");
  });

  it("живая сделка — «Резерв»", () => {
    expect(
      decidePropertyStatus("AVAILABLE", facts({ dealActive: true }))?.next,
    ).toBe("RESERVED");
  });

  it("резерв держится, сделки нет, срок истёк — обратно «В продаже»", () => {
    const decision = decidePropertyStatus(
      "RESERVED",
      facts({ reservationExpired: true }),
    );
    expect(decision?.next).toBe("AVAILABLE");
    expect(decision?.reason).toBe("reservation-gone");
  });

  /** Найдено код-ревью 13.08.2026: «Договор» в «Итоге показа» (routes/me.ts)
   *  ставит RESERVED раньше, чем появляется Deal, — на срок
   *  Settings.dealReservationBusinessDays. Без этой проверки ночная сверка
   *  снимала бы такую бронь в первую же ночь, до того как агент успел
   *  оформить сделку — фича автоброни откатывала бы сама себя. */
  it("резерв держится, сделки нет, но срок ЕЩЁ НЕ истёк — остаётся в резерве", () => {
    expect(
      decidePropertyStatus("RESERVED", facts({ reservationExpired: false })),
    ).toBeNull();
  });

  it("собственник отказался — объект снимается с продажи", () => {
    const decision = decidePropertyStatus(
      "AVAILABLE",
      facts({ sellerLost: true }),
    );
    expect(decision?.next).toBe("WITHDRAWN");
    expect(decision?.reason).toBe("seller-lost");
  });

  it("завершённая сделка сильнее живой — объект продан, а не в резерве", () => {
    const decision = decidePropertyStatus(
      "AVAILABLE",
      facts({ dealCompleted: true, dealActive: true }),
    );
    expect(decision?.next).toBe("SOLD");
  });

  it("идущая сделка сильнее отказа собственника — снимать объект посреди сделки нельзя", () => {
    expect(
      decidePropertyStatus(
        "AVAILABLE",
        facts({ dealActive: true, sellerLost: true }),
      )?.next,
    ).toBe("RESERVED");
  });
});

describe("Автостатус объекта: чего он делать не должен", () => {
  it("не трогает конвейер подготовки — там решают люди и одобрения материалов", () => {
    for (const status of [
      "PENDING_REVIEW",
      "AWAITING_PHOTOS",
      "AWAITING_VIDEO",
      "EDITING",
    ] as const) {
      expect(
        decidePropertyStatus(
          status,
          facts({ dealActive: true, sellerLost: true }),
        ),
      ).toBeNull();
    }
  });

  it("не возвращает в продажу снятый объект — это решение человека", () => {
    expect(decidePropertyStatus("WITHDRAWN", facts())).toBeNull();
  });

  it("не отменяет продажу", () => {
    expect(decidePropertyStatus("SOLD", facts())).toBeNull();
  });

  it("не пишет тот же статус повторно — история объекта не должна забиваться мусором", () => {
    expect(
      decidePropertyStatus("RESERVED", facts({ dealActive: true })),
    ).toBeNull();
    expect(decidePropertyStatus("AVAILABLE", facts())).toBeNull();
  });
});

const runId = Date.now();
let districtId: string;
const propertyIds: string[] = [];
const clientIds: string[] = [];

async function seedProperty(data: Record<string, unknown>) {
  const property = await prisma.property.create({
    data: {
      title: `Автостатус-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      ...data,
    } as never,
  });
  propertyIds.push(property.id);
  return property;
}

async function seedSeller(status: "NEW" | "LOST") {
  const client = await prisma.client.create({
    data: {
      fullName: `Собственник-${runId}-${clientIds.length}`,
      phone: `+9929${runId.toString().slice(-8)}${clientIds.length}`,
      kind: "SELLER",
      status,
      source: "WALK_IN",
    },
  });
  clientIds.push(client.id);
  return client;
}

beforeAll(async () => {
  const district = await prisma.district.create({
    data: { name: `Автостатус-${runId}` },
  });
  districtId = district.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({
    where: { entityId: { in: [...propertyIds, ...clientIds] } },
  });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

/** 10 календарных дней назад — заведомо больше любого разумного значения
 *  Settings.dealReservationBusinessDays (по умолчанию 3 рабочих), даже с учётом
 *  выходных внутри периода. */
const LONG_EXPIRED_RESERVED_AT = new Date(Date.now() - 10 * 24 * 3600_000);

describe("Автостатус объекта: что записывается в базу", () => {
  it("зависший (просроченный) резерв освобождается, отметка резерва снимается", async () => {
    const property = await seedProperty({
      status: "RESERVED",
      reservedAt: LONG_EXPIRED_RESERVED_AT,
    });

    expect(await refreshPropertyStatus(property.id)).toBe("AVAILABLE");
    const after = await prisma.property.findUnique({
      where: { id: property.id },
    });
    expect(after?.status).toBe("AVAILABLE");
    expect(after?.reservedAt).toBeNull();
  });

  /** Регресс-щит на баг код-ревью 13.08.2026: свежая бронь с «Договора» (до Deal)
   *  не должна сниматься при первой же ночной сверке. */
  it("свежий резерв (без сделки, срок ещё не истёк) НЕ снимается", async () => {
    const property = await seedProperty({
      status: "RESERVED",
      reservedAt: new Date(),
    });

    expect(await refreshPropertyStatus(property.id)).toBeNull();
    const after = await prisma.property.findUnique({
      where: { id: property.id },
    });
    expect(after?.status).toBe("RESERVED");
    expect(after?.reservedAt).not.toBeNull();
  });

  it("объект отказавшегося собственника снимается с продажи", async () => {
    const seller = await seedSeller("LOST");
    const property = await seedProperty({
      status: "AVAILABLE",
      sellerClientId: seller.id,
    });

    expect(await refreshPropertyStatus(property.id)).toBe("WITHDRAWN");
  });

  it("собственник в работе — объект остаётся в продаже", async () => {
    const seller = await seedSeller("NEW");
    const property = await seedProperty({
      status: "AVAILABLE",
      sellerClientId: seller.id,
    });

    expect(await refreshPropertyStatus(property.id)).toBeNull();
  });

  it("объект из Корзины не двигается вовсе", async () => {
    const seller = await seedSeller("LOST");
    const property = await seedProperty({
      status: "AVAILABLE",
      sellerClientId: seller.id,
      deletedAt: new Date(),
    });

    expect(await refreshPropertyStatus(property.id)).toBeNull();
    const after = await prisma.property.findUnique({
      where: { id: property.id },
    });
    expect(after?.status).toBe("AVAILABLE");
  });

  it("смена попадает в историю объекта как действие Системы", async () => {
    const property = await seedProperty({
      status: "RESERVED",
      reservedAt: LONG_EXPIRED_RESERVED_AT,
    });
    await refreshPropertyStatus(property.id);

    // Запись best-effort и без await внутри — ждём появления, а не проверяем сразу.
    const entry = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityId: property.id, action: "PROPERTY_STATUS_CHANGED" },
      }),
    );

    expect(entry).not.toBeNull();
    expect(entry?.agentId).toBeNull();
    expect(entry?.agentName).toBe("Система");
    expect(entry?.meta).toMatchObject({
      was: "RESERVED",
      becomes: "AVAILABLE",
      reason: "reservation-gone",
    });
  });
});

describe("«Собственник отказался» — только решение человека (жалоба 23.09.2026)", () => {
  it("продавца перевёл в Потерянные светофор — объект остаётся в продаже", async () => {
    const seller = await seedSeller("LOST");
    await prisma.client.update({
      where: { id: seller.id },
      data: { lostAt: new Date() },
    });
    await prisma.auditLog.create({
      data: {
        action: "CLIENT_AGENT_CHANGE",
        entityType: "Client",
        entityId: seller.id,
        agentId: null,
        agentName: "Система",
        meta: {
          source: "lost.promote",
          reason: "Светофор неактивных: предел попыток исчерпан",
        },
      },
    });
    const property = await seedProperty({
      status: "AVAILABLE",
      sellerClientId: seller.id,
    });
    await refreshPropertyStatus(property.id);
    const after = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
    });
    expect(after.status).toBe("AVAILABLE");
  });

  it("продавца перевёл в Потерянные человек — объект снимается, как и раньше", async () => {
    const seller = await seedSeller("LOST");
    await prisma.client.update({
      where: { id: seller.id },
      data: { lostAt: new Date() },
    });
    const property = await seedProperty({
      status: "AVAILABLE",
      sellerClientId: seller.id,
    });
    await refreshPropertyStatus(property.id);
    const after = await prisma.property.findUniqueOrThrow({
      where: { id: property.id },
    });
    expect(after.status).toBe("WITHDRAWN");
  });
});

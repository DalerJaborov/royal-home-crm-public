import { describe, expect, it } from "vitest";
import { PRICE_WAITLIST_DROPS_PCT, PRICE_WAITLIST_TAKE, PRICE_WAITLIST_VISIBLE_MAX } from "@royal-home/shared";
import {
  capWaitlistFetch,
  foldPriceWaitlist,
  stepPrice,
  type FoldPriceWaitlistInput,
  type WaitlistClientInput,
} from "../src/lib/priceWaitlist.js";

/**
 * Лист ожидания по цене — чистая свёртка, без базы. Курс 10 сомони за доллар, допуск бюджета ±10 %
 * (умолчание подбора). Объект стоит 400 000 сомони.
 */

const RATE = 10;
let seq = 0;

function client(over: Partial<WaitlistClientInput> & { maxTjs?: number | null; minTjs?: number | null }): WaitlistClientInput {
  seq += 1;
  const { maxTjs = null, minTjs = null, ...rest } = over;
  return {
    id: `c${seq}`,
    shortId: seq,
    fullName: `Клиент ${seq}`,
    assignedAgentId: "agent-a",
    budgetMinTjs: minTjs,
    budgetMaxTjs: maxTjs,
    budgetMaxOriginal: maxTjs,
    budgetCurrency: "TJS",
    ...rest,
  };
}

function fold(clients: WaitlistClientInput[], over: Partial<FoldPriceWaitlistInput> = {}) {
  return foldPriceWaitlist({
    propertyId: "p1",
    price: 400_000,
    currency: "TJS",
    onSale: true,
    priceToTjs: (a) => a,
    budgetTolerance: 0.1,
    clients,
    truncated: false,
    now: new Date("2026-10-03T10:00:00Z"),
    ...over,
  });
}

describe("stepPrice", () => {
  it("снижение вниз до целого: «не выше X» не округляется вверх", () => {
    expect(stepPrice(400_000, 3)).toBe(388_000);
    expect(stepPrice(99_999, 5)).toBe(94_999); // 94999.05 → вниз
  });
});

describe("foldPriceWaitlist — ступени", () => {
  // Допуск ±10 %: бюджет до B пропускает цену до 1,1·B.
  const clients = [
    client({ maxTjs: 400_000 }), // 440k с допуском ≥ 400k → подходит сейчас
    client({ maxTjs: 350_000 }), // 385k: 400k выше; ступень −3 % (388k) всё ещё выше; −5 % (380k) ≤ 385k → ступень 5
    client({ maxTjs: 340_000 }), // 374k: −8 % (368k) → ступень 8
    client({ maxTjs: 330_000 }), // 363k: −10 % (360k) → ступень 10
    client({ maxTjs: 300_000 }), // 330k: −15 % (340k) всё ещё выше → за пределами лестницы
    client({ maxTjs: 355_000 }), // 390.5k: −3 % (388k) → ступень 3
  ];

  it("считает накопительно и монотонно, итог = уже подходящие + прибавка", () => {
    const r = fold(clients);
    expect(r.fitNow).toBe(1);
    expect(r.overBudget).toBe(5);
    expect(r.beyondLadder).toBe(1);
    expect(r.steps.map((s) => s.dropPct)).toEqual([...PRICE_WAITLIST_DROPS_PCT]);
    expect(r.steps.map((s) => s.additional)).toEqual([1, 2, 3, 4, 4]);
    expect(r.steps.map((s) => s.total)).toEqual([2, 3, 4, 5, 5]);
    for (let i = 1; i < r.steps.length; i++) {
      expect(r.steps[i].additional).toBeGreaterThanOrEqual(r.steps[i - 1].additional);
      expect(r.steps[i].total).toBeGreaterThanOrEqual(r.steps[i - 1].total);
      expect(r.steps[i].price).toBeLessThan(r.steps[i - 1].price);
    }
  });

  it("порог — верхний предел с допуском: чуть выше границы ступени подходит, чуть ниже — нет", () => {
    // Ступень −5 % = 380 000. Бюджет 345 500 → 380 050 с допуском: подходит ступени 5 (и не подходит ступени 3 = 388 000).
    const above = fold([client({ maxTjs: 345_500 })]);
    expect(above.steps.map((s) => s.additional)).toEqual([0, 1, 1, 1, 1]);
    // Бюджет 345 000 → 379 500 с допуском: ступень 5 уже мимо, подходит ступень 8 (368 000).
    const below = fold([client({ maxTjs: 345_000 })]);
    expect(below.steps.map((s) => s.additional)).toEqual([0, 0, 1, 1, 1]);
  });

  it("сумма, у кого цена уже подходит, не зависит от ступеней", () => {
    const r = fold([client({ maxTjs: 500_000 }), client({ maxTjs: 450_000 }), client({ maxTjs: 441_000 })]);
    expect(r.fitNow).toBe(3);
    expect(r.overBudget).toBe(0);
    expect(r.steps.every((s) => s.additional === 0 && s.total === 3)).toBe(true);
  });

  it("валюты: бюджет в долларах приводится в сомони той же функцией, что у цены", () => {
    // Цена объекта 50 000 $ при курсе 10 → 500 000 сомони; клиент с бюджетом «до 40 000 $» (400 000 с.).
    const r = fold([client({ maxTjs: 400_000 }), client({ maxTjs: 440_000 }), client({ maxTjs: 1 })], {
      price: 50_000,
      currency: "USD",
      priceToTjs: (a) => a * RATE,
    });
    // Ступени в сомони: 485k, 475k, 460k, 450k, 425k. Пределы с допуском: 440k и 484k.
    // Клиент «до 440k» (484k с допуском) подходит с ступени −5 % (475k); «до 400k» (440k) — только с −15 % (425k).
    expect(r.steps.map((s) => s.price)).toEqual([48_500, 47_500, 46_000, 45_000, 42_500]);
    expect(r.steps.map((s) => s.additional)).toEqual([0, 1, 1, 1, 2]);
  });

  it("клиенты без бюджета в ступени не входят и считаются отдельно", () => {
    const r = fold([client({ maxTjs: 400_000 }), client({}), client({}), client({ maxTjs: 350_000 }), client({ maxTjs: 345_000 })]);
    expect(r.noBudget).toBe(2);
    expect(r.sample).toBe(3);
    expect(r.fitNow + r.overBudget + r.belowBudget).toBe(r.sample);
  });

  it("только нижняя граница бюджета: цена выше неё не мешает, ниже — «слишком дёшево», в ступени не входит", () => {
    const r = fold([client({ minTjs: 300_000 }), client({ minTjs: 600_000 }), client({ maxTjs: 350_000 })]);
    expect(r.fitNow).toBe(1); // minTjs 300k: цена 400k не ниже
    expect(r.belowBudget).toBe(1); // 600k·0,9 = 540k > 400k
    expect(r.overBudget).toBe(1);
  });
});

describe("foldPriceWaitlist — мало данных и пустота", () => {
  it("пустой лист: нули, мало данных, ступени на месте", () => {
    const r = fold([]);
    expect(r.sample).toBe(0);
    expect(r.enoughData).toBe(false);
    expect(r.steps).toHaveLength(PRICE_WAITLIST_DROPS_PCT.length);
    expect(r.steps.every((s) => s.additional === 0 && s.total === 0)).toBe(true);
    expect(r.visibleClients).toEqual([]);
  });

  it("два клиента с бюджетом — мало данных; три — достаточно", () => {
    expect(fold([client({ maxTjs: 350_000 }), client({ maxTjs: 360_000 })]).enoughData).toBe(false);
    expect(fold([client({ maxTjs: 350_000 }), client({ maxTjs: 360_000 }), client({ maxTjs: 370_000 })]).enoughData).toBe(true);
  });

  it("клиенты без бюджета не делают выборку «достаточной»", () => {
    expect(fold([client({}), client({}), client({}), client({})]).enoughData).toBe(false);
  });

  it("truncated пробрасывается", () => {
    expect(fold([], { truncated: true }).truncated).toBe(true);
  });
});

describe("foldPriceWaitlist — видимые клиенты", () => {
  const mine1 = client({ maxTjs: 350_000, assignedAgentId: "agent-a" });
  const mine2 = client({ maxTjs: 500_000, assignedAgentId: "agent-a" });
  const foreign = client({ maxTjs: 355_000, assignedAgentId: "agent-b" });
  const none = client({ maxTjs: 345_000, assignedAgentId: null });

  it("агент получает только своих", () => {
    const r = fold([mine1, mine2, foreign, none], { visibleToAgentId: "agent-a" });
    expect(r.visibleScope).toBe("own");
    expect(r.visibleClients.map((c) => c.id).sort()).toEqual([mine1.id, mine2.id].sort());
    // Числа при этом — по всем: чужие клиенты в счётчиках есть, а в списке нет.
    expect(r.fitNow + r.overBudget).toBe(4);
  });

  it("руководитель (без ограничения) получает всех", () => {
    const r = fold([mine1, mine2, foreign, none]);
    expect(r.visibleScope).toBe("all");
    expect(r.visibleClients).toHaveLength(4);
  });

  it("список упорядочен по ступени (мягче снижение — выше), «уже подходит» — в конце, и ограничен", () => {
    const r = fold([mine2, mine1, foreign]);
    const stages = r.visibleClients.map((c) => c.fitsAtDropPct);
    expect(stages[stages.length - 1]).toBe(0);
    expect(stages.slice(0, -1)).toEqual([...stages.slice(0, -1)].sort((a, b) => a - b));
    const many = Array.from({ length: PRICE_WAITLIST_VISIBLE_MAX + 20 }, () => client({ maxTjs: 360_000 }));
    expect(fold(many).visibleClients).toHaveLength(PRICE_WAITLIST_VISIBLE_MAX);
  });

  it("у клиента нет полей телефона: наружу идёт только id, номер, имя, бюджет и ступень", () => {
    const r = fold([mine1]);
    expect(Object.keys(r.visibleClients[0]).sort()).toEqual(["budgetCurrency", "budgetMax", "fitsAtDropPct", "fullName", "id", "shortId"]);
  });
});

describe("capWaitlistFetch — truncated только когда покупателей больше предела", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("ровно PRICE_WAITLIST_TAKE покупателей — полный список, не «числа занижены»", () => {
    const r = capWaitlistFetch(rows(PRICE_WAITLIST_TAKE));
    expect(r.truncated).toBe(false);
    expect(r.rows).toHaveLength(PRICE_WAITLIST_TAKE);
  });

  it("на одного больше (запрос берёт TAKE + 1) — усечено, лишняя строка в расчёт не идёт", () => {
    const r = capWaitlistFetch(rows(PRICE_WAITLIST_TAKE + 1));
    expect(r.truncated).toBe(true);
    expect(r.rows).toHaveLength(PRICE_WAITLIST_TAKE);
  });

  it("меньше предела и пусто — не усечено", () => {
    expect(capWaitlistFetch(rows(3)).truncated).toBe(false);
    expect(capWaitlistFetch([]).rows).toEqual([]);
  });
});

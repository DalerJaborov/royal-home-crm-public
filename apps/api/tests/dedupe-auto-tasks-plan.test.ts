import { describe, expect, it } from "vitest";
import { computeDedupePlan, matchPrefix, type OpenTaskRow } from "../../../scripts/dedupe-auto-tasks.js";

/**
 * scripts/dedupe-auto-tasks.ts — разовая чистка накопленных дублей (21.09.2026).
 * computeDedupePlan — чистая функция (вход/выход, без базы), проверяем её
 * напрямую: режим показа не должен зависеть от того, есть ли рядом Postgres.
 * Сам скрипт (`main()`) читает эту же функцию — реальная запись в базу
 * проверяется прогоном `npx tsx scripts/dedupe-auto-tasks.ts` на стенде, не тут.
 */

function row(overrides: Partial<OpenTaskRow>): OpenTaskRow {
  return {
    id: "id",
    clientId: "client",
    nextAction: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("matchPrefix", () => {
  it("узнаёт известные автогенераторы по префиксу текста", () => {
    expect(matchPrefix("Перезвонить — клиент звонил сам и не дозвонился")).toBe("inbound_missed_callback");
    expect(matchPrefix("Перезвонить — клиент не ответил (попытка 2 из 3)")).toBe("no_answer_retry");
    expect(matchPrefix("Добавьте объект по заявке ПК-000012 — уже 10 дн.")).toBe("deal_stale_seller_add_property");
  });

  it("не узнаёт произвольный текст ручной задачи", () => {
    expect(matchPrefix("Позвонить клиенту после обеда, сам попросил")).toBeNull();
  });
});

describe("computeDedupePlan — режим показа ничего не меняет, только считает", () => {
  it("не находит дублей, когда у клиента одна задача каждого вида", () => {
    const plan = computeDedupePlan([
      row({ id: "1", clientId: "c1", nextAction: "Перезвонить — клиент звонил сам и не дозвонился", createdAt: new Date(2000) }),
      row({ id: "2", clientId: "c1", nextAction: "Закройте сделку или обновите статус по заявке ПК-1 — уже 21 дн.", createdAt: new Date(1000) }),
    ]);
    expect(plan).toHaveLength(0);
  });

  it("оставляет самую свежую запись каждой группы, остальные помечает к снятию", () => {
    // Три «Перезвонить — попытка N из 3» одного клиента — ровно дефект из
    // жалобы владельца (81 задача на 32 клиента, 21.09.2026).
    const newest = row({ id: "newest", clientId: "c1", nextAction: "Перезвонить — клиент не ответил (попытка 3 из 3)", createdAt: new Date(3000) });
    const middle = row({ id: "middle", clientId: "c1", nextAction: "Перезвонить — клиент не ответил (попытка 2 из 3)", createdAt: new Date(2000) });
    const oldest = row({ id: "oldest", clientId: "c1", nextAction: "Перезвонить — клиент не ответил (попытка 1 из 3)", createdAt: new Date(1000) });

    // computeDedupePlan ожидает вход, отсортированный createdAt DESC (как orderBy
    // в самом скрипте) — передаём в этом порядке, самая свежая первой.
    const plan = computeDedupePlan([newest, middle, oldest]);

    expect(plan.map((p) => p.id).sort()).toEqual(["middle", "oldest"]);
    expect(plan.every((p) => p.label === "no_answer_retry")).toBe(true);
  });

  it("не группирует разные виды задач одного клиента друг с другом", () => {
    const plan = computeDedupePlan([
      row({ id: "1", clientId: "c1", nextAction: "Перезвонить — клиент звонил сам и не дозвонился", createdAt: new Date(2000) }),
      row({ id: "2", clientId: "c1", nextAction: "Проверить контакт с клиентом ПК-1 — 3 недозвона подряд", createdAt: new Date(1000) }),
    ]);
    expect(plan).toHaveLength(0);
  });

  it("не группирует одинаковый вид задачи между РАЗНЫМИ клиентами", () => {
    const plan = computeDedupePlan([
      row({ id: "1", clientId: "c1", nextAction: "Перезвонить — клиент звонил сам и не дозвонился", createdAt: new Date(2000) }),
      row({ id: "2", clientId: "c2", nextAction: "Перезвонить — клиент звонил сам и не дозвонился", createdAt: new Date(1000) }),
    ]);
    expect(plan).toHaveLength(0);
  });

  it("игнорирует произвольный текст ручной задачи — не подгоняет её ни под один вид", () => {
    const plan = computeDedupePlan([
      row({ id: "1", clientId: "c1", nextAction: "Перезвонить клиенту после обеда, сам попросил", createdAt: new Date(2000) }),
      row({ id: "2", clientId: "c1", nextAction: "Перезвонить клиенту после обеда, сам попросил", createdAt: new Date(1000) }),
    ]);
    expect(plan).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { classifyDialLeg, parseAnsweredSeconds } from "../src/lib/telephony/ariEvents.js";

/**
 * Разговор начинается только там, где станция набрала КЛИЕНТА.
 *
 * В режиме «на мобильный» станция делает два вызова наружу: сначала звонит
 * сотруднику, и только когда тот снял трубку — клиенту. Оба дают событие Dial с
 * ANSWER, и первое из них — про сотрудника.
 *
 * Живой случай 13.08.2026 (журнал станции): `6501414 → 880001007` ответил за 40
 * секунд (сотрудник), `6501414 → 777776010` не ответил вовсе (клиент) — а в CRM
 * звонок записан разговором на 42 секунды, с записью из одних гудков, за
 * расшифровку которой заплатили. Ни исхода «не дозвонились», ни серии перезвонов
 * при этом не завелось.
 *
 * До 18.08.2026 проверка была ОБРАТНОЙ («это не сотрудник — значит клиент»), и
 * именно поэтому не срабатывала ни разу: без dialstring номер брался у вызываемого
 * канала, а там номер клиента лежит в ОБОИХ плечах.
 */
describe("плечо к клиенту в событии Dial", () => {
  it("узнаёт плечо к клиенту (в CRM номер международный, станция набирает девять цифр)", () => {
    expect(
      classifyDialLeg({ type: "Dial", dialstatus: "ANSWER", dialstring: "SIP/out/777776010" }, "+992777776010")
    ).toBe("client");
  });

  it("плечо к мобильному сотрудника разговором НЕ считает", () => {
    expect(
      classifyDialLeg({ type: "Dial", dialstatus: "ANSWER", dialstring: "SIP/out/880001007" }, "+992777776010")
    ).toBe("other");
  });

  it("плечо к внутреннему номеру сотрудника разговором НЕ считает", () => {
    expect(
      classifyDialLeg({ type: "Dial", dialstatus: "ANSWER", dialstring: "Local/1005@from-internal" }, "+992777776010")
    ).toBe("other");
  });

  /**
   * ГЛАВНОЕ ИЗМЕНЕНИЕ 18.08.2026. Добавочный у вызываемого канала — не доказательство:
   * у отслеживаемой половинки Local там номер клиента и тогда, когда станция звонит
   * ещё только сотруднику. Доказательств нет — плечо «непонятно чьё»: разговор
   * засчитывается, как и раньше, но неподтверждённым, и его перебьёт DIALSTATUS.
   */
  it("без dialstring ничего не решает — даже если добавочный вызываемого совпал", () => {
    expect(
      classifyDialLeg(
        {
          type: "Dial",
          dialstatus: "ANSWER",
          peer: {
            id: "ch-2",
            name: "SIP/out-00000039",
            state: "Up",
            caller: {},
            dialplan: { context: "from-internal", exten: "777776010" },
          },
        },
        "+992777776010"
      )
    ).toBe("unknown");
    expect(classifyDialLeg({ type: "Dial", dialstatus: "ANSWER" }, "+992777776010")).toBe("unknown");
    expect(classifyDialLeg({ type: "Dial", dialstatus: "ANSWER", dialstring: "SIP/out/777776010" }, undefined)).toBe(
      "unknown"
    );
  });
});

/**
 * ANSWEREDTIME — длительность второго плеча, по ней восстанавливается момент ответа
 * клиента. Ошибка формата здесь стоила бы разговора длиной в одну шестидесятую от
 * настоящего.
 */
describe("длительность разговора из ANSWEREDTIME", () => {
  it("целые секунды", () => {
    expect(parseAnsweredSeconds("36")).toBe(36);
    expect(parseAnsweredSeconds("0")).toBe(0);
  });

  it("формат «мм:сс» разбирается как минуты и секунды", () => {
    expect(parseAnsweredSeconds("1:05")).toBe(65);
    expect(parseAnsweredSeconds("0:42")).toBe(42);
    expect(parseAnsweredSeconds("1:00:30")).toBe(3630);
  });

  it("мусор, отрицательное и абсурдно большое не берём вовсе", () => {
    expect(parseAnsweredSeconds(null)).toBeNull();
    expect(parseAnsweredSeconds("")).toBeNull();
    expect(parseAnsweredSeconds("-5")).toBeNull();
    expect(parseAnsweredSeconds("abc")).toBeNull();
    // Больше суток разговора не бывает — это не длительность, а сбой.
    expect(parseAnsweredSeconds("90000")).toBeNull();
  });
});

/**
 * LOCAL-КАНАЛ С ФЛАГАМИ ЗА КОНТЕКСТОМ (22.09.2026).
 *
 * Именно так originate из CRM набирает агента: `Local/<номер>@from-internal/n`,
 * суффикс /n обязателен (без него Asterisk схлопывает Local-канал и рвёт разговор,
 * см. originateCall). Разбор «всё после последнего слэша» давал из этого букву «n»,
 * плечо к САМОМУ АГЕНТУ объявлялось «непонятно чьим», а «непонятно чьё» + ANSWER —
 * это разговор: ответ агента снова становился разговором с клиентом. На проде
 * 21–22.09.2026 — пятнадцать «разговоров» по 3–13 секунд, у которых плечо к клиенту
 * в CDR станции стоит NO ANSWER.
 */
describe("Local-канал с флагами за контекстом", () => {
  it("плечо к мобильному агента через Local/…@from-internal/n — это НЕ клиент", () => {
    expect(
      classifyDialLeg(
        { type: "Dial", dialstatus: "ANSWER", dialstring: "Local/000001017@from-internal/n" },
        "+992030001026"
      )
    ).toBe("other");
  });

  it("плечо к внутреннему номеру агента через Local/1004@from-internal/n — тоже НЕ клиент", () => {
    expect(
      classifyDialLeg({ type: "Dial", dialstatus: "ANSWER", dialstring: "Local/1004@from-internal/n" }, "+992030001026")
    ).toBe("other");
  });

  it("если через Local набран сам клиент — это всё-таки клиент", () => {
    expect(
      classifyDialLeg(
        { type: "Dial", dialstatus: "ANSWER", dialstring: "Local/030001026@from-internal/n" },
        "+992030001026"
      )
    ).toBe("client");
  });
});

import { describe, expect, it } from "vitest";
import { clientNameFor, withHiddenOrigin, withHiddenConversationOrigin, HIDDEN_ORIGIN_NAME } from "../src/lib/clientOrigin.js";

/**
 * ОТКУДА ПРИШЁЛ КЛИЕНТ — ТОЛЬКО РУКОВОДСТВУ (владелец 17.08.2026).
 *
 * Дословно: «ник полностью скрыть от агентов навсегда… агентам нельзя показывать
 * нигде, откуда клиент пришёл, ватсап или инстаграм — это только для руководителя
 * и админа».
 *
 * Зачем правило вообще: ник соцсети — способ найти клиента в обход агентства. По
 * «@tabarovmukhammadzoir» человек находится в Instagram за секунду, дальше ему
 * пишут напрямую, и ни разговора, ни следа в CRM не остаётся. Тот же повод, по
 * которому закрыт телефон (lib/clientPhone.ts).
 *
 * Тест на чистые функции: у правила ОДНО место (lib/clientOrigin.ts), и урок,
 * записанный в clientPhone.ts дословно — «правило, записанное в одном маршруте, не
 * является правилом» — держится именно на том, что это место одно.
 */

describe("Имя клиента: ник подменяется, настоящее имя остаётся", () => {
  it("ник со @ скрывается от агента", () => {
    expect(clientNameFor("@tabarovmukhammadzoir", false)).toBe(HIDDEN_ORIGIN_NAME);
  });

  it("руководителю ник виден как есть", () => {
    expect(clientNameFor("@tabarovmukhammadzoir", true)).toBe("@tabarovmukhammadzoir");
  });

  it("настоящее имя агенту НЕ прячется — иначе он не сможет работать", () => {
    expect(clientNameFor("Мадина Каримова", false)).toBe("Мадина Каримова");
    expect(clientNameFor("Ноза", false)).toBe("Ноза");
  });

  /** Старые карточки (до 17.08) заводились с подписью канала вместо имени —
   *  «Клиент из Instagram». Она тоже называет платформу, то есть выдаёт то самое. */
  it("прежняя подпись с названием канала тоже скрывается", () => {
    expect(clientNameFor("Клиент из Instagram", false)).toBe(HIDDEN_ORIGIN_NAME);
    expect(clientNameFor("Клиент из WhatsApp", false)).toBe(HIDDEN_ORIGIN_NAME);
  });
});

describe("Карточка клиента: источник закрыт правом", () => {
  it("агенту source обнуляется, а ник в имени подменяется", () => {
    const shown = withHiddenOrigin({ fullName: "@daler9000xx", source: "INSTAGRAM" }, false);
    expect(shown.source).toBeNull();
    expect(shown.fullName).toBe(HIDDEN_ORIGIN_NAME);
  });

  it("руководителю всё видно как есть", () => {
    const shown = withHiddenOrigin({ fullName: "@daler9000xx", source: "INSTAGRAM" }, true);
    expect(shown.source).toBe("INSTAGRAM");
    expect(shown.fullName).toBe("@daler9000xx");
  });

  it("исходный объект не портится — правило возвращает копию", () => {
    const original = { fullName: "@nick", source: "WHATSAPP" };
    withHiddenOrigin(original, false);
    expect(original.source).toBe("WHATSAPP");
    expect(original.fullName).toBe("@nick");
  });

  it("пустого клиента переживает без проверок у каждого вызова", () => {
    expect(withHiddenOrigin(null, false)).toBeNull();
    expect(withHiddenOrigin(undefined, false)).toBeUndefined();
  });
});

describe("Диалог в инбоксе: канал закрыт правом", () => {
  it("агенту канал обнуляется — значок мессенджера и есть ответ «откуда пришёл»", () => {
    const shown = withHiddenConversationOrigin({ channel: "INSTAGRAM", name: "@user123" }, false);
    expect(shown.channel).toBeNull();
    expect(shown.name).toBe(HIDDEN_ORIGIN_NAME);
  });

  it("настоящее имя в диалоге остаётся, канал всё равно скрыт", () => {
    const shown = withHiddenConversationOrigin({ channel: "WHATSAPP", name: "Мадина" }, false);
    expect(shown.channel).toBeNull();
    expect(shown.name).toBe("Мадина");
  });

  it("руководителю канал виден", () => {
    const shown = withHiddenConversationOrigin({ channel: "WHATSAPP", name: "Мадина" }, true);
    expect(shown.channel).toBe("WHATSAPP");
  });
});

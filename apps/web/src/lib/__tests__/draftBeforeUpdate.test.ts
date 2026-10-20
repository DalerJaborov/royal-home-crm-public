import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeDraftBeforeUpdate,
  saveDraftBeforeUpdate,
  subscribeDraftBeforeUpdate,
  configureDraftBeforeUpdateSession,
  clearDraftsBeforeUpdate,
} from "../draftBeforeUpdate";

/**
 * Черновик поля/формы, переживающий принудительную перезагрузку при
 * автообновлении (находка ночной проверки 24.09.2026, №246/К2-4): до этой
 * правки `rh:before-app-update` никто не слушал, и набранный текст пропадал.
 *
 * Тест без jsdom (не установлен в этом воркспейсе, environment: "node" в
 * vitest.config.ts) — sessionStorage стабится вручную (как в
 * appUpdateNotice.test.ts), а `window` — настоящим `EventTarget`, который
 * есть глобально в Node: `subscribeDraftBeforeUpdate` вызывает самый
 * настоящий `window.addEventListener`/`dispatchEvent`, а не заглушку метода.
 */
function installStorage() {
  const data = new Map<string, string>();
  configureDraftBeforeUpdateSession(() => ({ actorId: "agent-A", epoch: 1 }));
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
    },
  });
  return data;
}

function installWindow() {
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  return target;
}

describe("saveDraftBeforeUpdate/consumeDraftBeforeUpdate — снимок значения", () => {
  beforeEach(installStorage);

  it("сохранённое находится и стирается — второй раз тот же ключ уже пуст", () => {
    saveDraftBeforeUpdate("conv-1", "не отправленный ответ", (v) => !v);
    expect(consumeDraftBeforeUpdate("conv-1")).toBe("не отправленный ответ");
    expect(consumeDraftBeforeUpdate("conv-1")).toBeNull();
  });

  it("пустое значение не сохраняется", () => {
    saveDraftBeforeUpdate("conv-2", "", (v) => !v);
    expect(consumeDraftBeforeUpdate("conv-2")).toBeNull();
  });

  it("пустое значение поверх уже сохранённого стирает черновик", () => {
    saveDraftBeforeUpdate("conv-3", "текст", (v) => !v);
    saveDraftBeforeUpdate("conv-3", "", (v) => !v);
    expect(consumeDraftBeforeUpdate("conv-3")).toBeNull();
  });

  it("работает с объектом (форма клиента) и своим isEmpty", () => {
    const draft = { fullName: "Иван", phone: "" };
    saveDraftBeforeUpdate("client-new:BUYER", draft, (v) => !v.fullName && !v.phone);
    expect(consumeDraftBeforeUpdate("client-new:BUYER")).toEqual(draft);
  });

  it("недоступное хранилище (приватный режим) не роняет вызов", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("private mode");
      },
    });
    expect(() => saveDraftBeforeUpdate("conv-4", "текст", (v) => !v)).not.toThrow();
    expect(consumeDraftBeforeUpdate("conv-4")).toBeNull();
  });
});

describe("subscribeDraftBeforeUpdate — по сигналу rh:before-app-update", () => {
  let win: EventTarget;

  beforeEach(() => {
    installStorage();
    win = installWindow();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("событие сохраняет самое свежее значение, а не то, что было при подписке", () => {
    let current = "черно";
    const unsubscribe = subscribeDraftBeforeUpdate("conv-5", () => current, (v) => !v);
    current = "черновик набран целиком";

    win.dispatchEvent(new CustomEvent("rh:before-app-update"));

    expect(consumeDraftBeforeUpdate("conv-5")).toBe("черновик набран целиком");
    unsubscribe();
  });

  it("без события ничего не пишет", () => {
    subscribeDraftBeforeUpdate("conv-6", () => "текст", (v) => !v);
    expect(consumeDraftBeforeUpdate("conv-6")).toBeNull();
  });

  it("отписка — событие после неё уже не сохраняет", () => {
    const unsubscribe = subscribeDraftBeforeUpdate("conv-7", () => "текст", (v) => !v);
    unsubscribe();
    win.dispatchEvent(new CustomEvent("rh:before-app-update"));
    expect(consumeDraftBeforeUpdate("conv-7")).toBeNull();
  });

  it("пустое значение в момент события черновик не заводит", () => {
    subscribeDraftBeforeUpdate("conv-8", () => "", (v) => !v);
    win.dispatchEvent(new CustomEvent("rh:before-app-update"));
    expect(consumeDraftBeforeUpdate("conv-8")).toBeNull();
  });
});

describe("snapshot ownership across session transitions", () => {
  it("does not restore historical unowned data or another actor's snapshot", () => {
    const data = installStorage();
    data.set("rh:draft-before-update:client-new:BUYER", JSON.stringify({ phone: "old-phone" }));
    expect(consumeDraftBeforeUpdate("client-new:BUYER")).toBeNull();
    expect(data.has("rh:draft-before-update:client-new:BUYER")).toBe(false);
    saveDraftBeforeUpdate("client-new:BUYER", { phone: "A-phone" }, () => false);
    configureDraftBeforeUpdateSession(() => ({ actorId: "agent-B", epoch: 2 }));
    expect(consumeDraftBeforeUpdate("client-new:BUYER")).toBeNull();
    configureDraftBeforeUpdateSession(() => ({ actorId: "agent-A", epoch: 1 }));
    expect(consumeDraftBeforeUpdate("client-new:BUYER")).toEqual({ phone: "A-phone" });
  });
  it("clears all snapshot generations without removing unrelated session data", () => {
    const data = installStorage();
    data.set("rh:draft-before-update:old-key", "old-data");
    data.set("unrelated", "keep");
    saveDraftBeforeUpdate("conv-1", "private", () => false);
    clearDraftsBeforeUpdate();
    expect([...data]).toEqual([["unrelated", "keep"]]);
  });
  it.each(["other-actor", "same-actor-new-session"])("a still-mounted old subscription cannot save after %s", (transition) => {
    const data = installStorage();
    const win = installWindow();
    let session = { actorId: "agent-A", epoch: 1 };
    configureDraftBeforeUpdateSession(() => session);
    const unsubscribe = subscribeDraftBeforeUpdate("client-new:BUYER", () => "A-private", () => false);
    session = { actorId: transition === "other-actor" ? "agent-B" : "agent-A", epoch: 2 };
    win.dispatchEvent(new Event("rh:before-app-update"));
    expect(data.size).toBe(0);
    unsubscribe();
    Reflect.deleteProperty(globalThis, "window");
  });
});

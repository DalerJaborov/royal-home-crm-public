import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LISTENERS_PER_SESSION,
  backlogFromTranscript,
  getBacklog,
  listActive,
  publishAudio,
  publishTranscript,
  resetLiveVoiceMonitorForTests,
  sessionEnded,
  sessionStarted,
  subscribe,
  totalSubscribersForTests,
  type ListenEvent,
} from "../src/lib/telephony/liveVoiceMonitor.js";

/**
 * Прослушка живого голоса: реестр и шина событий в памяти. Главное свойство —
 * слушалка не может уронить или задержать звонок: без подписчиков публикация
 * ничего не делает, упавший обработчик не мешает остальным.
 */

const start = (key = "s1", extra: Partial<Parameters<typeof sessionStarted>[0]> = {}) =>
  sessionStarted({ key, channelId: `ch-${key}`, callerNumber: "+992900000001", direction: "inbound", ...extra });

afterEach(() => resetLiveVoiceMonitorForTests());

describe("реестр активных разговоров", () => {
  it("разговор виден после старта и исчезает после конца", () => {
    start("a");
    start("b");
    expect(listActive().map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(listActive()[0]).toMatchObject({ direction: "inbound", callerNumber: "+992900000001", listeners: 0 });
    sessionEnded("a", "hangup");
    expect(listActive().map((s) => s.id)).toEqual(["b"]);
    sessionEnded("b", "hangup");
    expect(listActive()).toEqual([]);
  });

  it("конец неизвестного разговора и повторный конец безвредны", () => {
    expect(() => sessionEnded("нет такого", "x")).not.toThrow();
    start("a");
    sessionEnded("a", "x");
    expect(() => sessionEnded("a", "x")).not.toThrow();
  });

  it("слишком старая запись (конец не дошёл) вычищается из списка", () => {
    start("old", { startedAt: Date.now() - 2 * 60 * 60_000 });
    start("fresh");
    expect(listActive().map((s) => s.id)).toEqual(["fresh"]);
  });
});

describe("подписка и публикация", () => {
  it("подписчик получает реплики, звук и конец, отписавшись — ничего", () => {
    start("a");
    const got: ListenEvent[] = [];
    const off = subscribe("a", (e) => got.push(e))!;
    expect(off).toBeTypeOf("function");
    publishTranscript("a", "client", "Алло");
    publishAudio("a", "bot", new Int16Array([1, 2, 3]));
    expect(got.map((e) => e.kind)).toEqual(["transcript", "audio"]);
    expect(got[0]).toMatchObject({ kind: "transcript", role: "client", text: "Алло" });
    expect(got[1]).toMatchObject({ kind: "audio", side: "bot" });
    off();
    off(); // повторная отписка безвредна
    publishTranscript("a", "bot", "Здравствуйте");
    expect(got).toHaveLength(2);
    expect(totalSubscribersForTests()).toBe(0);
  });

  it("конец разговора доходит до слушателей и снимает их", () => {
    start("a");
    const got: ListenEvent[] = [];
    subscribe("a", (e) => got.push(e));
    sessionEnded("a", "hangup");
    expect(got).toEqual([{ kind: "end", reason: "hangup" }]);
    expect(totalSubscribersForTests()).toBe(0);
    expect(subscribe("a", () => {})).toBeNull();
  });

  it("подписка на неизвестный разговор — null", () => {
    expect(subscribe("нет", () => {})).toBeNull();
  });

  it("предел слушателей на разговор; после отписки место освобождается", () => {
    start("a");
    const offs = Array.from({ length: MAX_LISTENERS_PER_SESSION }, () => subscribe("a", () => {})!);
    expect(offs.every(Boolean)).toBe(true);
    expect(subscribe("a", () => {})).toBeNull();
    expect(listActive()[0].listeners).toBe(MAX_LISTENERS_PER_SESSION);
    offs[0]();
    expect(subscribe("a", () => {})).toBeTypeOf("function");
  });

  it("слушатели разных разговоров не видят чужое", () => {
    start("a");
    start("b");
    const a: ListenEvent[] = [];
    const b: ListenEvent[] = [];
    subscribe("a", (e) => a.push(e));
    subscribe("b", (e) => b.push(e));
    publishTranscript("a", "client", "только А");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});

describe("нулевая цена и защита звонка", () => {
  it("без подписчиков публикация не обращается к реестру и не бросает", () => {
    start("a");
    const spy = vi.spyOn(Map.prototype, "get");
    const pcm = new Int16Array(160);
    for (let i = 0; i < 1000; i++) publishAudio("a", "client", pcm);
    publishTranscript("a", "bot", "текст");
    // Ранний выход по счётчику: к карте реестра никто не обращался.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("публикация в неизвестный разговор — тишина", () => {
    start("a");
    subscribe("a", () => {});
    expect(() => publishAudio("нет", "client", new Int16Array(1))).not.toThrow();
    expect(() => publishTranscript("нет", "bot", "x")).not.toThrow();
  });

  it("упавший обработчик не мешает остальным и сам отписывается", () => {
    start("a");
    const good: ListenEvent[] = [];
    subscribe("a", () => {
      throw new Error("слушатель сломался");
    });
    subscribe("a", (e) => good.push(e));
    expect(() => publishTranscript("a", "client", "раз")).not.toThrow();
    publishTranscript("a", "client", "два");
    expect(good).toHaveLength(2);
    expect(listActive()[0].listeners).toBe(1);
    expect(totalSubscribersForTests()).toBe(1);
  });

  it("отписка во время обхода (конец разговора) не ломает счётчик", () => {
    start("a");
    let off: (() => void) | null = null;
    off = subscribe("a", () => off?.());
    subscribe("a", () => {});
    sessionEnded("a", "x");
    expect(totalSubscribersForTests()).toBe(0);
  });
});

describe("накопленная расшифровка для подключившегося посреди разговора", () => {
  it("читается лениво — только по запросу", () => {
    const backlog = vi.fn(() => [{ role: "client" as const, text: "Привет" }]);
    start("a", { backlog });
    publishTranscript("a", "client", "x");
    expect(backlog).not.toHaveBeenCalled();
    expect(getBacklog("a")).toEqual([{ role: "client", text: "Привет" }]);
    expect(backlog).toHaveBeenCalledTimes(1);
  });

  it("отказ источника — пустой список, а не ошибка", () => {
    start("a", {
      backlog: () => {
        throw new Error("x");
      },
    });
    expect(getBacklog("a")).toEqual([]);
    expect(getBacklog("нет")).toEqual([]);
  });

  it("строки моста превращаются в реплики: куски склеиваются, служебные пометки пропускаются", () => {
    expect(
      backlogFromTranscript(["Бот: Здрав", "Бот: ствуйте", "Клиент: Алло", "[эскалация к оператору] причина", "Бот: Слушаю вас"])
    ).toEqual([
      { role: "bot", text: "Здравствуйте" },
      { role: "client", text: "Алло" },
      { role: "bot", text: "Слушаю вас" },
    ]);
  });
});

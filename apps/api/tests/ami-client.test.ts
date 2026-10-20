import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { amiAction, amiDbDel, amiDbGet, amiDbPut, parseAmiPacket, withAmiConnection } from "../src/lib/telephony/amiClient.js";

/**
 * Управление станцией из CRM (AMI) — проверяется на поддельной станции, без живой АТС.
 *
 * Поддельная станция здесь не роскошь: протокол текстовый, и ошибка в разборе пакетов
 * проявилась бы не отказом, а зависшей кнопкой в интерфейсе — то есть тем самым
 * молчанием, из-за которого телефонию потом чинят по SSH.
 */

interface FakeStation {
  port: number;
  /** Всё, что CRM прислала станции, — по пакетам. */
  received: Record<string, string>[];
  close(): Promise<void>;
}

/**
 * Поддельная станция: здоровается, принимает вход и отвечает на действие тем, что
 * задано сценарием. `null` в сценарии — молчание (проверка таймаута).
 */
async function startStation(reply: (action: Record<string, string>) => string | null): Promise<FakeStation> {
  const received: Record<string, string>[] = [];
  const server = net.createServer((socket) => {
    socket.write("Asterisk Call Manager/5.0.2\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let boundary = buffer.indexOf("\r\n\r\n");
      while (boundary !== -1) {
        const packet = parseAmiPacket(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 4);
        boundary = buffer.indexOf("\r\n\r\n");
        received.push(packet);
        const action = (packet.action ?? "").toLowerCase();
        if (action === "login") {
          socket.write(`Response: Success\r\nActionID: ${packet.actionid}\r\nMessage: Authentication accepted\r\n\r\n`);
          continue;
        }
        if (action === "logoff") continue;
        const answer = reply(packet);
        if (answer !== null) socket.write(answer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let station: FakeStation | null = null;

afterEach(async () => {
  await station?.close();
  station = null;
});

function creds(port: number) {
  return { host: "127.0.0.1", port, username: "royalhome-crm", password: "secret" };
}

describe("управление станцией через AMI", () => {
  it("входит и выполняет действие", async () => {
    station = await startStation(
      (packet) => `Response: Success\r\nActionID: ${packet.actionid}\r\nMessage: Updated database successfully\r\n\r\n`
    );

    const result = await amiDbPut(creds(station.port), "ROYALHOME/failover", "phone", "930001001");

    expect(result.ok).toBe(true);
    const login = station.received.find((p) => p.action === "Login");
    expect(login?.username).toBe("royalhome-crm");
    // События станции CRM слушает через ARI; на этом соединении они только мешают.
    expect(login?.events).toBe("off");
    const put = station.received.find((p) => p.action === "DBPut");
    expect(put).toMatchObject({ family: "ROYALHOME/failover", key: "phone", val: "930001001" });
  });

  it("отказ станции возвращается человеку словами, а не молчанием", async () => {
    station = await startStation(
      (packet) => `Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: Permission denied\r\n\r\n`
    );

    const result = await amiDbPut(creds(station.port), "ROYALHOME/failover", "phone", "930001001");

    expect(result).toEqual({ ok: false, error: "Permission denied" });
  });

  it("неверный пароль — отказ на входе, действие не отправляется", async () => {
    const received: Record<string, string>[] = [];
    const server = net.createServer((socket) => {
      socket.write("Asterisk Call Manager/5.0.2\r\n");
      socket.on("data", (chunk) => {
        const packet = parseAmiPacket(chunk.toString());
        received.push(packet);
        socket.write(`Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: Authentication failed\r\n\r\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const result = await amiAction({ host: "127.0.0.1", port, username: "x", password: "нет" }, "DBPut");

    expect(result).toEqual({ ok: false, error: "Authentication failed" });
    expect(received.some((p) => p.action === "DBPut")).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("читает значение из базы станции", async () => {
    station = await startStation((packet) =>
      packet.action === "DBGet"
        ? `Response: Success\r\nActionID: ${packet.actionid}\r\nEventList: start\r\n\r\n` +
          `Event: DBGetResponse\r\nActionID: ${packet.actionid}\r\nFamily: ${packet.family}\r\nKey: ${packet.key}\r\nVal: 930001001\r\n\r\n` +
          `Event: DBGetComplete\r\nActionID: ${packet.actionid}\r\nEventList: Complete\r\n\r\n`
        : null
    );

    const result = await amiDbGet(creds(station.port), "ROYALHOME/failover", "phone");

    expect(result).toEqual({ ok: true, value: "930001001" });
  });

  /** Ключа нет — это пустое значение, а не поломка: правило просто ещё не настроено. */
  it("отсутствующий ключ не считает ошибкой", async () => {
    station = await startStation(
      (packet) => `Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: Database entry not found\r\n\r\n`
    );

    const result = await amiDbGet(creds(station.port), "ROYALHOME/failover", "phone");

    expect(result).toEqual({ ok: true, value: null });
  });

  /** Удаление того, чего нет, — успех: цель достигнута, значения не существует. */
  it("удаление отсутствующего ключа — успех", async () => {
    station = await startStation(
      (packet) => `Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: Database entry not found\r\n\r\n`
    );

    const result = await amiDbDel(creds(station.port), "ROYALHOME/blacklist", "992900000000");

    expect(result.ok).toBe(true);
  });

  /**
   * Станция молчит (оборвался туннель) — кнопка обязана вернуть отказ, а не висеть.
   * Порог в тесте короткий: пять секунд настоящего таймаута прогон не должен ждать.
   */
  it("молчание станции превращается в понятный отказ", async () => {
    station = await startStation(() => null);

    const result = await amiAction(creds(station.port), "Ping", {}, { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("не ответила");
  });

  it("недоступный порт — тоже отказ, а не исключение", async () => {
    // Порт, на котором заведомо никто не слушает: соединение отвергается сразу.
    const result = await amiAction({ host: "127.0.0.1", port: 1, username: "x", password: "y" }, "Ping", {}, { timeoutMs: 500 });

    expect(result.ok).toBe(false);
  });
});

/**
 * withAmiConnection — одна сессия на несколько действий подряд (06.09.2026,
 * см. заголовок функции в amiClient.ts). Проверяется РОВНО ТО, ради чего она
 * написана: Login один раз на несколько действий, а не по разу на каждое —
 * дальше вся собранная в redirectChannelToAgent цепочка Setvar+Redirect либо
 * работает, либо нет ровно так же, как раньше работали отдельные amiAction().
 */
describe("withAmiConnection — одна сессия на несколько действий", () => {
  it("несколько действий подряд — один Login, каждое получает свой ответ по порядку", async () => {
    let n = 0;
    station = await startStation((packet) => {
      n++;
      return `Response: Success\r\nActionID: ${packet.actionid}\r\nMessage: ok-${n}\r\n\r\n`;
    });

    const results = await withAmiConnection(creds(station.port), async (send) => {
      const a = await send("Setvar", { Channel: "SIP/1", Variable: "X", Value: "1" });
      const b = await send("Setvar", { Channel: "SIP/1", Variable: "Y", Value: "2" });
      const c = await send("Redirect", { Channel: "SIP/1", Context: "royalhome-agent-route", Exten: "agent", Priority: 1 });
      return [a, b, c];
    });

    expect(results.every((r) => r.ok)).toBe(true);
    const logins = station.received.filter((p) => p.action === "Login");
    expect(logins).toHaveLength(1);
    const actions = station.received.filter((p) => p.action !== "Login" && p.action !== "Logoff");
    expect(actions.map((p) => p.action)).toEqual(["Setvar", "Setvar", "Redirect"]);
    // Ответы пришли именно в том порядке, в каком отправлялись действия.
    expect((results[0] as { ok: true; packets: Record<string, string>[] }).packets[0].message).toBe("ok-1");
    expect((results[2] as { ok: true; packets: Record<string, string>[] }).packets[0].message).toBe("ok-3");
  });

  it("отказ станции на одном действии не рушит сессию — callback сам решает, продолжать ли", async () => {
    station = await startStation((packet) =>
      packet.variable === "BAD"
        ? `Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: станция отказала\r\n\r\n`
        : `Response: Success\r\nActionID: ${packet.actionid}\r\n\r\n`
    );

    const results = await withAmiConnection(creds(station.port), async (send) => {
      const first = await send("Setvar", { Channel: "SIP/1", Variable: "BAD", Value: "1" });
      // Ровно то, что делает redirectChannelToAgent: узнав об отказе, дальше не идёт.
      if (!first.ok) return [first];
      const second = await send("Setvar", { Channel: "SIP/1", Variable: "OK", Value: "1" });
      return [first, second];
    });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });

  it("неверный пароль — run() ни разу не вызывается, действие не уходит", async () => {
    let ranCallback = false;
    const received: Record<string, string>[] = [];
    const server = net.createServer((socket) => {
      socket.write("Asterisk Call Manager/5.0.2\r\n");
      socket.on("data", (chunk) => {
        const packet = parseAmiPacket(chunk.toString());
        received.push(packet);
        socket.write(`Response: Error\r\nActionID: ${packet.actionid}\r\nMessage: Authentication failed\r\n\r\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    await expect(
      withAmiConnection({ host: "127.0.0.1", port, username: "x", password: "нет" }, async (send) => {
        ranCallback = true;
        return send("Ping");
      })
    ).rejects.toThrow("Authentication failed");

    expect(ranCallback).toBe(false);
    expect(received).toHaveLength(1); // только Login, действие из callback не ушло
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("станция молчит на одном из действий — это действие отказывает по таймауту, сессия не виснет", async () => {
    let calls = 0;
    station = await startStation((packet) => {
      calls++;
      // Первое действие отвечает, второе — молчание (порог короткий, проверка таймаута).
      return calls === 1 ? `Response: Success\r\nActionID: ${packet.actionid}\r\n\r\n` : null;
    });

    const results = await withAmiConnection(creds(station.port), async (send) => {
      const a = await send("Setvar", { Channel: "SIP/1", Variable: "X", Value: "1" }, { timeoutMs: 300 });
      const b = await send("Setvar", { Channel: "SIP/1", Variable: "Y", Value: "2" }, { timeoutMs: 300 });
      return [a, b];
    });

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].ok === false && results[1].error).toContain("не ответила");
  });

  it("недоступный порт — внешний промис проваливается, а не висит", async () => {
    await expect(
      withAmiConnection({ host: "127.0.0.1", port: 1, username: "x", password: "y" }, async (send) => send("Ping"))
    ).rejects.toBeTruthy();
  });
});

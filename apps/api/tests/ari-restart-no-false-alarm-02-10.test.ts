import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

/**
 * E5 глубокой проверки 02.10.2026, сценарий 2: директор сохраняет настройки
 * телефонии, restartAriEvents закрывает старый сокет и открывает новый. close
 * старого приходит асинхронно — уже при stopped=false — и считался обрывом:
 * «связи со станцией нет», начало окна «не на связи», лишняя переподписка, а с
 * долгой предысторией связи — тревога и пуш директорам на каждое сохранение.
 *
 * Настоящий сокет к локальному серверу ws: сеть до станции не нужна.
 */

const { creds } = vi.hoisted(() => ({ creds: { url: "", username: "u", password: "p" } }));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: vi.fn(async () => creds),
  listActiveChannels: vi.fn(async () => []),
}));
vi.mock("../src/lib/telephony/incomingCalls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/incomingCalls.js")>()),
  refreshInboundContexts: vi.fn(async () => {}),
}));
vi.mock("../src/lib/telephony/failoverSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/failoverSync.js")>()),
  reconcileFailoverOnReconnect: vi.fn(async () => {}),
}));
vi.mock("../src/lib/telephony/routingModeSync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/routingModeSync.js")>()),
  reconcileRoutingModeOnReconnect: vi.fn(async () => {}),
}));

const { startAriEvents, stopAriEvents, restartAriEvents, isStationConnected } = await import("../src/lib/telephony/ariEvents.js");

let server: WebSocketServer;
let connections = 0;

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", () => connections++);
  await new Promise((r) => server.once("listening", r));
  creds.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  stopAriEvents();
  for (const c of server.clients) c.terminate();
  await new Promise((r) => server.close(r));
  const { prisma } = await import("../src/db.js");
  await prisma.$disconnect();
});

describe("перезапуск подписки после правки Настроек — не обрыв", () => {
  it("закрытие старого сокета не пишет «связи со станцией нет» и не заводит третий сокет", async () => {
    startAriEvents();
    await until(() => connections === 1 && isStationConnected());

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    restartAriEvents();
    await until(() => connections >= 2 && isStationConnected());
    // close старого сокета и возможная лишняя переподписка успевают прийти.
    await new Promise((r) => setTimeout(r, 1_500));

    const lost = warn.mock.calls.filter((c) => String(c[0]).includes("связи со станцией нет"));
    expect(lost).toEqual([]);
    expect(connections).toBe(2);
    warn.mockRestore();
  });
});

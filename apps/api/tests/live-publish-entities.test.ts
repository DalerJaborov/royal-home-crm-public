import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { __resetEventBusForTests, subscribe } from "../src/lib/eventBus.js";
import {
  publishCallUpdated,
  publishClientUpdated,
  publishPropertyUpdated,
  publishRequestUpdated,
} from "../src/lib/livePublish.js";
import type { LiveEvent } from "@royal-home/shared";

/**
 * ТОЧКИ ПУБЛИКАЦИИ СОБЫТИЙ ВТОРОГО ЗАХОДА (13.09.2026): звонок, клиент, объект,
 * заявка на рассмотрение.
 *
 * Проверяется ровно то, чем эти события отличаются от уже проверенных в
 * live-events.test.ts: адресация (надзор видит всегда, исполнитель — поимённо)
 * и состав нагрузки (только идентификаторы и короткие признаки, без содержимого).
 * Сама шина — доставка, билеты, пределы подписок — покрыта там же и здесь не
 * дублируется.
 */

const DIRECTOR = "live-publish-test-director";
const AGENT = "live-publish-test-agent";
const OTHER = "live-publish-test-other";

/** Собрать события трёх зрителей за время одной публикации. */
async function capture(run: () => void): Promise<{
  overseer: LiveEvent[];
  agent: LiveEvent[];
  stranger: LiveEvent[];
}> {
  const overseer: LiveEvent[] = [];
  const agent: LiveEvent[] = [];
  const stranger: LiveEvent[] = [];
  const off1 = subscribe({ agentId: DIRECTOR, role: "DIRECTOR", deliver: (e) => overseer.push(e) });
  const off2 = subscribe({ agentId: AGENT, role: "AGENT", deliver: (e) => agent.push(e) });
  const off3 = subscribe({ agentId: OTHER, role: "AGENT", deliver: (e) => stranger.push(e) });
  run();
  // publish() fire-and-forget: одна вставка в базу, ждём её обычным тиком.
  await new Promise((r) => setTimeout(r, 200));
  off1();
  off2();
  off3();
  return { overseer, agent, stranger };
}

afterEach(() => {
  __resetEventBusForTests();
});

afterAll(async () => {
  await prisma.liveEventOutbox.deleteMany({
    where: { type: { in: ["call.updated", "client.updated", "property.updated", "request.updated"] } },
  });
});

describe("живые события второго захода", () => {
  it("звонок: надзор и исполнитель видят, посторонний агент — нет", async () => {
    const got = await capture(() => publishCallUpdated({ callId: "call-1", clientId: "cl-1", agentId: AGENT }));
    expect(got.overseer.map((e) => e.type)).toEqual(["call.updated"]);
    expect(got.agent.map((e) => e.type)).toEqual(["call.updated"]);
    expect(got.stranger).toEqual([]);
    expect(got.agent[0].payload).toEqual({ callId: "call-1", clientId: "cl-1" });
  });

  it("клиент: адресуется ОБОИМ исполнителям — новому и прежнему", async () => {
    const got = await capture(() =>
      publishClientUpdated({ clientId: "cl-2", agentIds: [AGENT, OTHER, null], stage: "ACTIVE", actorId: AGENT })
    );
    expect(got.agent.map((e) => e.type)).toEqual(["client.updated"]);
    // Прежний исполнитель обязан увидеть, что карточка ушла из его списка.
    expect(got.stranger.map((e) => e.type)).toEqual(["client.updated"]);
    expect(got.overseer[0].payload).toEqual({ clientId: "cl-2", stage: "ACTIVE", actorId: AGENT });
  });

  it("объект: событие несёт только идентификатор и короткий признак статуса", async () => {
    const got = await capture(() =>
      publishPropertyUpdated({ propertyId: "pr-1", agentId: AGENT, stage: "AVAILABLE", actorId: DIRECTOR })
    );
    expect(got.agent[0].payload).toEqual({ propertyId: "pr-1", stage: "AVAILABLE", actorId: DIRECTOR });
    expect(got.stranger).toEqual([]);
  });

  it("заявка: строка ложится в общую таблицу — её увидит второй процесс", async () => {
    await capture(() =>
      publishRequestUpdated({ requestId: "rq-1", propertyId: "pr-2", agentIds: [AGENT], stage: "PENDING" })
    );
    const row = await prisma.liveEventOutbox.findFirst({
      where: { type: "request.updated" },
      orderBy: { seq: "desc" },
    });
    expect(row?.agentIds).toEqual([AGENT]);
    expect(row?.payload).toEqual({ requestId: "rq-1", propertyId: "pr-2", stage: "PENDING" });
    // Надзор адресуется ролями, а не поимённо: состав директоров меняется.
    expect(row?.roles).toContain("DIRECTOR");
  });
});

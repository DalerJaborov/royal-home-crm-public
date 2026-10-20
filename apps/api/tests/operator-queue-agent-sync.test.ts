import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";

/**
 * Связь CRM ↔ очередь входящих (владелец 19.08.2026): деактивированный или
 * замороженный агент обязан выпасть из ringall-очереди сам, без ручной правки
 * станции. syncAgentQueuePresence ставит существующего участника очереди на
 * паузу через AMI QueuePause — состав очереди (queues_details на станции) не
 * трогает вовсе, поэтому AMI здесь целиком в моках: тестируем только решение
 * «кого поставить на паузу», а не сам протокол.
 */

vi.mock("../src/lib/telephony/amiClient.js", () => ({
  loadAmiCredentials: vi.fn().mockResolvedValue({ host: "pbx", port: 5038, username: "x", password: "y" }),
  amiQueueStatus: vi.fn(),
  amiQueuePause: vi.fn(),
}));

const { amiQueueStatus, amiQueuePause } = await import("../src/lib/telephony/amiClient.js");
const { syncAgentQueuePresence, reconcileOperatorQueuePresence } = await import("../src/lib/telephony/operatorQueue.js");

const runId = Date.now();
let activeAgentId: string;
let frozenAgentId: string;
let inactiveAgentId: string;
let frozenManagerOperatorId: string;

function queueStatusPacketsFor(extension: string) {
  return [
    {
      event: "QueueMember",
      queue: "1000",
      location: `Local/${extension}@from-queue/n`,
      paused: "0",
    },
  ];
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  activeAgentId = (
    await prisma.agent.create({
      data: { fullName: `Синк активный ${runId}`, phone: `+992961${runId}`, role: "AGENT", passwordHash, sipExtension: `71${runId % 1000}` },
    })
  ).id;
  frozenAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `Синк заморожен ${runId}`,
        phone: `+992962${runId}`,
        role: "AGENT",
        passwordHash,
        sipExtension: `72${runId % 1000}`,
        frozenAt: new Date(),
      },
    })
  ).id;
  inactiveAgentId = (
    await prisma.agent.create({
      data: {
        fullName: `Синк отключён ${runId}`,
        phone: `+992963${runId}`,
        role: "AGENT",
        passwordHash,
        sipExtension: `73${runId % 1000}`,
        isActive: false,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.agent.deleteMany({
    where: { id: { in: [activeAgentId, frozenAgentId, inactiveAgentId, frozenManagerOperatorId].filter(Boolean) } },
  });
  await prisma.$disconnect();
});

describe("syncAgentQueuePresence", () => {
  it("активный незамороженный агент — снимает паузу (не должен молчать в очереди)", async () => {
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`71${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await syncAgentQueuePresence(activeAgentId);

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`71${runId % 1000}`),
      false,
      "статус в CRM"
    );
  });

  it("замороженный агент — ставится на паузу", async () => {
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`72${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await syncAgentQueuePresence(frozenAgentId);

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`72${runId % 1000}`),
      true,
      "статус в CRM"
    );
  });

  it("отключённый (isActive=false) агент — тоже ставится на паузу", async () => {
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`73${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await syncAgentQueuePresence(inactiveAgentId);

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`73${runId % 1000}`),
      true,
      "статус в CRM"
    );
  });

  it("агент без внутреннего номера — не трогает AMI вовсе", async () => {
    vi.mocked(amiQueuePause).mockClear();
    const noExt = await prisma.agent.create({
      data: { fullName: `Без номера ${runId}`, phone: `+992964${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("x", 10) },
    });
    await syncAgentQueuePresence(noExt.id);
    expect(amiQueuePause).not.toHaveBeenCalled();
    await prisma.agent.delete({ where: { id: noExt.id } });
  });
});

describe("reconcileOperatorQueuePresence — не снимает паузу, которую агент поставил себе сам", () => {
  it("активного незамороженного агента обход вообще не трогает (не вызывает AMI для него)", async () => {
    vi.mocked(amiQueueStatus).mockClear();
    vi.mocked(amiQueuePause).mockClear();
    // amiQueueStatus замокан один раз без привязки к конкретному номеру — если бы
    // обход вызвал его для активного агента, это было бы видно по числу вызовов.
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: [] });

    await reconcileOperatorQueuePresence();

    // Единственный активный агент в фикстурах этого файла — activeAgentId; для
    // него ни QueueStatus, ни QueuePause обязаны не вызываться вовсе (найдено
    // ревью 19.08.2026: раньше обход СНИМАЛ паузу «Отошёл», которую агент
    // поставил себе сам, потому что видел его как «активен → должен быть не
    // на паузе» и бездумно применял это каждые 5 минут).
    expect(amiQueuePause).not.toHaveBeenCalled();
  });

  it("замороженного агента обход ставит на паузу, даже если тот уже отвечал ok=false раньше", async () => {
    vi.mocked(amiQueueStatus).mockClear();
    vi.mocked(amiQueuePause).mockClear();
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`72${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await reconcileOperatorQueuePresence();

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`72${runId % 1000}`),
      true,
      "статус в CRM"
    );
  });
});

/**
 * №224 (ночная проверка 24.09): оператор первой линии — признак
 * `takesUnknownCalls`, а не роль (решение владельца 20.09.2026). Синхронизация
 * паузы смотрела только на `role === "AGENT"`, поэтому замороженный
 * оператор-руководитель оставался в очереди не на паузе, и незнакомый звонок
 * звонил в пустоту.
 */
describe("пауза в очереди — по статусу, а не по роли", () => {
  beforeAll(async () => {
    frozenManagerOperatorId = (
      await prisma.agent.create({
        data: {
          fullName: `Синк руководитель-оператор ${runId}`,
          phone: `+992965${runId}`,
          role: "MANAGER",
          passwordHash: await bcrypt.hash("x", 10),
          sipExtension: `74${runId % 1000}`,
          takesUnknownCalls: true,
          frozenAt: new Date(),
        },
      })
    ).id;
  });

  it("замороженный оператор-руководитель ставится на паузу сразу при смене статуса", async () => {
    vi.mocked(amiQueuePause).mockClear();
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`74${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await syncAgentQueuePresence(frozenManagerOperatorId);

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`74${runId % 1000}`),
      true,
      "статус в CRM"
    );
  });

  it("сторожевой обход тоже ставит его на паузу", async () => {
    vi.mocked(amiQueuePause).mockClear();
    vi.mocked(amiQueueStatus).mockResolvedValue({ ok: true, packets: queueStatusPacketsFor(`74${runId % 1000}`) });
    vi.mocked(amiQueuePause).mockResolvedValue({ ok: true, packets: [] });

    await reconcileOperatorQueuePresence();

    expect(amiQueuePause).toHaveBeenCalledWith(
      expect.anything(),
      "1000",
      expect.stringContaining(`74${runId % 1000}`),
      true,
      "статус в CRM"
    );
  });
});

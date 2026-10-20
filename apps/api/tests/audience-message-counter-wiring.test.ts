import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/**
 * СЧЁТЧИК ТЕПЛОВОЙ КАРТЫ ПОДКЛЮЧЁН К ПРИЁМУ СООБЩЕНИЙ (23.09.2026).
 *
 * Сам счёт проверяет audience-heatmap.test.ts. Здесь — провод: каждое
 * сообщение клиента доходит до счётчика, а реплика сотрудника со своего
 * аккаунта и повтор зависшего хода — нет. Порвись провод — карта молча
 * вернулась бы к двум отметкам на диалог, и ни одна проверка бы этого не
 * заметила: пустой счётчик выглядит как «клиенты не пишут».
 *
 * Счётчик подменён шпионом, а не прочитан из базы: соседние файлы в том же
 * прогоне тоже зовут processMessengerTurn, и число в текущем часе у них растёт.
 */

const { recordAudienceMessage, callAi } = vi.hoisted(() => ({
  recordAudienceMessage: vi.fn(async () => {}),
  callAi: vi.fn(),
}));
vi.mock("../src/lib/audienceHeatmap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audienceHeatmap.js")>()),
  recordAudienceMessage,
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { prisma } = await import("../src/db.js");
const { processMessengerTurn } = await import("../src/messengers/conversation.js");

const runId = Date.now().toString(36);
const SUBSCRIBER = `heat-wire-${runId}`;
let instagram: CustomerMessengerFixture;
beforeAll(async () => { instagram = await createCustomerMessengerFixture("INSTAGRAM"); });

beforeEach(() => {
  recordAudienceMessage.mockClear();
});

afterAll(async () => {
  const conv = await prisma.botConversation.findFirst({
    where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
    select: { id: true, clientId: true },
  });
  if (conv) {
    if (conv.clientId) await prisma.client.deleteMany({ where: { id: conv.clientId } });
  }
  await instagram.dispose();
});

describe("Сообщение клиента попадает в счёт тепловой карты", () => {
  it("сообщение клиента — в счёт своего канала", async () => {
    await processMessengerTurn({ ...instagram.turnInput(SUBSCRIBER), text: "Салом", silent: true });
    expect(recordAudienceMessage).toHaveBeenCalledWith("INSTAGRAM");
  });

  it("реплика сотрудника со своего аккаунта — не клиент, в счёт не идёт", async () => {
    await processMessengerTurn({
      ...instagram.turnInput(SUBSCRIBER),
      text: "Здравствуйте, это агент",
      silent: true,
      fromStaff: true,
    });
    expect(recordAudienceMessage).not.toHaveBeenCalled();
  });

  it("повтор зависшего хода — не новое сообщение, второй раз не считается", async () => {
    callAi.mockResolvedValue({ bubbles: ["Ҳа"] });
    await processMessengerTurn({
      ...instagram.turnInput(SUBSCRIBER),
      text: "Салом",
      skipSaveIncoming: true,
      retryOfPaidTurn: true,
      silent: true,
    });
    expect(recordAudienceMessage).not.toHaveBeenCalled();
  });
});

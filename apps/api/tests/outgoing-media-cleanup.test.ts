import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Уборка исходящих фото/видео оператора в R2 (lib/outgoingMediaCleanup.ts).
 *
 *  Гарантии, тот же порядок проверки, что и у соседних R2-уборок:
 *  1. Свежее вложение (моложе 7 суток) не трогаем — Meta уже доставила, но клиент
 *     или руководитель может ещё открыть переписку и посмотреть файл.
 *  2. Файл в R2 удаляется ПЕРЕД записью `expiredAt` — обратный порядок терял бы
 *     файл навсегда без единой ссылки на него.
 *  3. Вложение КЛИЕНТА (без `url`, только `file`) не трогаем никогда — это не
 *     наша исходящая отправка, а закрытое хранилище с другим циклом жизни. */

const r2Delete = vi.fn<(key: string) => Promise<boolean>>();
vi.mock("../src/lib/r2Client.js", () => ({ r2Delete: (key: string) => r2Delete(key) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn() }));

const { prisma } = await import("../src/db.js");
const { cleanupExpiredOutgoingMedia } = await import("../src/lib/outgoingMediaCleanup.js");

const runId = Date.now();
const ids: string[] = [];

async function makeConversation(messages: unknown[], lastMessageAt: Date) {
  const c = await prisma.botConversation.create({
    data: { channel: "WHATSAPP", subscriberId: `cleanup-${runId}-${Math.random()}`, messages: messages as object, lastMessageAt },
  });
  ids.push(c.id);
  return c;
}

function outgoingAttachment(conversationId: string, atDaysAgo: number) {
  const at = new Date(Date.now() - atDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    role: "assistant",
    content: "[📷 фото]",
    at,
    by: { kind: "agent", agentId: "a1", agentName: "Фарход" },
    attachments: [{ kind: "image", mime: "image/jpeg", url: `/api/v1/media/chat/${conversationId}/test.jpg`, file: null }],
  };
}

beforeEach(() => {
  r2Delete.mockReset();
  r2Delete.mockResolvedValue(true);
});

afterAll(async () => {
  if (ids.length > 0) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe("уборка исходящих фото/видео", () => {
  it("НЕ трогает вложение моложе 7 суток", async () => {
    const c = await makeConversation([], new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const msg = outgoingAttachment(c.id, 3);
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });

    await cleanupExpiredOutgoingMedia();
    expect(r2Delete).not.toHaveBeenCalledWith(`chat-media/${c.id}/test.jpg`);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { attachments?: { expiredAt?: string }[] }[];
    expect(messages[0].attachments?.[0].expiredAt).toBeUndefined();
  });

  it("убирает вложение старше 7 суток: удаляет из R2 и помечает expiredAt, реплика остаётся", async () => {
    const c = await makeConversation([], new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const msg = outgoingAttachment(c.id, 10);
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });

    await cleanupExpiredOutgoingMedia();
    expect(r2Delete).toHaveBeenCalledWith(`chat-media/${c.id}/test.jpg`);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { expiredAt?: string }[] }[];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("[📷 фото]");
    expect(messages[0].attachments?.[0].expiredAt).toBeTruthy();
  });

  it("НЕ трогает вложение клиента (нет url, только file) — не наша отправка", async () => {
    const c = await makeConversation([], new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const msg = {
      role: "user",
      content: "",
      at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      attachments: [{ kind: "image", mime: "image/jpeg", file: "client-photo.jpg" }],
    };
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });

    await cleanupExpiredOutgoingMedia();
    expect(r2Delete).not.toHaveBeenCalledWith(`chat-media/${c.id}/test.jpg`);
  });

  it("при отказе R2 файл не помечается истёкшим — ссылка на платный объект не теряется", async () => {
    const c = await makeConversation([], new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const msg = outgoingAttachment(c.id, 10);
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });
    r2Delete.mockResolvedValue(false);

    await cleanupExpiredOutgoingMedia();
    expect(r2Delete).toHaveBeenCalledWith(`chat-media/${c.id}/test.jpg`);

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { attachments?: { expiredAt?: string }[] }[];
    expect(messages[0].attachments?.[0].expiredAt).toBeUndefined();
  });

  it("CHANNEL-NEW-07: сообщение клиента, пришедшее во время r2Delete, не теряется", async () => {
    const { appendConversationMessages } = await import("../src/messengers/appendMessages.js");
    const c = await makeConversation([], new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    const msg = outgoingAttachment(c.id, 10);
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });

    // Управляемая задержка: удаление нашего файла «висит», пока тест не отпустит.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const deleting = new Promise<void>((resolve) => { started = resolve; });
    r2Delete.mockImplementation(async (key: string) => {
      if (key === `chat-media/${c.id}/test.jpg`) {
        started();
        await gate;
      }
      return true;
    });

    const run = cleanupExpiredOutgoingMedia();
    await deleting;
    // Клиент вернулся после недели тишины: вебхук дописывает атомарно, как в бою.
    await appendConversationMessages(c.id, [{ role: "user", content: "здравствуйте, ещё актуально?" }]);
    release();
    await run;

    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { content: string; attachments?: { expiredAt?: string }[] }[];
    expect(messages.map((m) => m.content)).toEqual(["[📷 фото]", "здравствуйте, ещё актуально?"]);
    expect(messages[0].attachments?.[0].expiredAt).toBeTruthy();
  });

  it("НЕ трогает диалог, где lastMessageAt свежий, даже если внутри есть старая реплика", async () => {
    const c = await makeConversation([], new Date());
    const msg = outgoingAttachment(c.id, 10);
    await prisma.botConversation.update({ where: { id: c.id }, data: { messages: [msg] } });

    await cleanupExpiredOutgoingMedia();
    // Проверяем СВОЙ диалог, а не глобальный счётчик прохода: база общая на все
    // тесты файла (и потенциально на параллельную сессию), в ней могут быть
    // другие старые диалоги — счётчик result.conversations им не изолирован.
    const saved = await prisma.botConversation.findUnique({ where: { id: c.id } });
    const messages = saved!.messages as unknown as { attachments?: { expiredAt?: string }[] }[];
    expect(messages[0].attachments?.[0].expiredAt).toBeUndefined();
    expect(r2Delete).not.toHaveBeenCalledWith(`chat-media/${c.id}/test.jpg`);
  });
});

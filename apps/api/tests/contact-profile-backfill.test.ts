import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { backfillContactProfiles } from "../src/lib/contactProfileBackfill.js";
import { parseContactCategoryHistory } from "@royal-home/shared";

/**
 * РАЗБОР ПРЕЖНИХ ПЕРЕПИСОК В ДОСЬЕ.
 *
 * Досье завелись 21.09.2026, и у тех, кто писал раньше, их нет: вернувшемуся
 * клиенту бот отвечает как незнакомому. Проверяется то, ради чего разбор
 * делается, и то, чем он опасен:
 *
 *  1. переписка в WhatsApp и звонок с ТОГО ЖЕ номера сходятся в ОДНО досье —
 *     иначе разбор наплодит по досье на канал и сделает хуже, чем было;
 *  2. первое касание берётся из архива, а не из «сегодня»: «пишет нам с
 *     сегодняшнего дня» у человека месячной давности — ложь боту в промте;
 *  3. карточка клиента переносится;
 *  4. категория выводится из сохранённого черновика и помечена как выведенная
 *     кодом (`guard`), а не сказанная моделью в разговоре;
 *  5. режим показа НЕ пишет в базу вовсе;
 *  6. повторный запуск не заводит второе досье на те же записи.
 *
 * Номера одной длины из одной полосы и уборка за собой — известная ловушка
 * этого репозитория.
 */

const digits6 = String(Date.now()).slice(-6);
/** wa_id приходит как «992…» без «+»: девять цифр после кода страны. */
const WA_ID = `992917${digits6.slice(0, 3)}`;
const runId = Date.now().toString(36).slice(-6);
// Имя в досье чистится (lib/spokenName.ts): цифр в имени нет, поэтому метка для имени — только буквы.
const nameTag = runId.replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]);

const MONTH_AGO = new Date(Date.now() - 30 * 86_400_000);
const WEEK_AGO = new Date(Date.now() - 7 * 86_400_000);

let clientId = "";
const createdConversations: string[] = [];
const createdCalls: string[] = [];

async function cleanup(): Promise<void> {
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: [WA_ID, WA_ID.slice(-9)] } },
    select: { profileId: true },
  });
  const profileIds = [...new Set(rows.map((r) => r.profileId))];
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversations } } });
  await prisma.incomingCall.deleteMany({ where: { id: { in: createdCalls } } });
  if (profileIds.length > 0) {
    await prisma.contactLinkCandidate.deleteMany({
      where: { OR: [{ leftId: { in: profileIds } }, { rightId: { in: profileIds } }] },
    });
    await prisma.contactIdentity.deleteMany({ where: { profileId: { in: profileIds } } });
    await prisma.contactProfile.deleteMany({ where: { id: { in: profileIds } } });
  }
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
}

beforeAll(async () => {
  await cleanup();
  const client = await prisma.client.create({
    data: { fullName: `Хангома ${nameTag}`, phone: `+${WA_ID}`, source: "WHATSAPP" },
    select: { id: true },
  });
  clientId = client.id;

  // Переписка месячной давности: человек писал, черновик успел запомнить, что он
  // покупает, а досье в те дни ещё не существовало.
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: WA_ID,
      name: "Хангома",
      clientId,
      createdAt: MONTH_AGO,
      lastMessageAt: WEEK_AGO,
      leadDraft: { intent: "buy", stage: "chatting" },
      messages: [
        { role: "user", content: "салом, хона мекобам" },
        { role: "assistant", content: "Салом! Дар кадом ноҳия?" },
        { role: "user", content: "Исмоили Сомонӣ" },
      ],
    },
    select: { id: true },
  });
  createdConversations.push(conversation.id);

  // Звонок с ТОГО ЖЕ номера — станция определила его сама.
  const call = await prisma.incomingCall.create({
    data: { channelId: `bf-${runId}`, phone: `+${WA_ID}`, startedAt: WEEK_AGO, clientId },
    select: { id: true },
  });
  createdCalls.push(call.id);
});

afterAll(cleanup);

describe("разбор прежних переписок в досье", () => {
  it("режим показа считает записи и НЕ пишет в базу", async () => {
    const stats = await backfillContactProfiles();
    expect(stats.conversations).toBeGreaterThanOrEqual(1);
    expect(stats.calls).toBeGreaterThanOrEqual(1);
    expect(stats.profiles).toBe(0);
    const row = await prisma.botConversation.findUnique({
      where: { id: createdConversations[0] },
      select: { contactProfileId: true },
    });
    expect(row!.contactProfileId).toBeNull();
  });

  it("переписка и звонок с того же номера сходятся в одно досье", async () => {
    await backfillContactProfiles({ apply: true });
    const conversation = await prisma.botConversation.findUnique({
      where: { id: createdConversations[0] },
      select: { contactProfileId: true },
    });
    const call = await prisma.incomingCall.findUnique({
      where: { id: createdCalls[0] },
      select: { contactProfileId: true },
    });
    expect(conversation!.contactProfileId).not.toBeNull();
    // Главное свойство разбора: по досье на канал — это хуже, чем ничего.
    expect(call!.contactProfileId).toBe(conversation!.contactProfileId);
  });

  it("первое касание берётся из архива, карточка клиента переносится", async () => {
    const conversation = await prisma.botConversation.findUnique({
      where: { id: createdConversations[0] },
      select: { contactProfileId: true },
    });
    const profile = await prisma.contactProfile.findUnique({
      where: { id: conversation!.contactProfileId! },
      select: {
        firstSeenAt: true,
        lastSeenAt: true,
        messagesIn: true,
        clientId: true,
        category: true,
        categoryHistory: true,
        displayName: true,
      },
    });
    // Месяц назад, а не «сегодня»: иначе бот прочитает «пишет нам с сегодняшнего
    // дня» про человека, который пишет месяц.
    expect(profile!.firstSeenAt.getTime()).toBeCloseTo(MONTH_AGO.getTime(), -4);
    expect(profile!.lastSeenAt.getTime()).toBeCloseTo(WEEK_AGO.getTime(), -4);
    // Две реплики человека из трёх сохранённых сообщений; звонок в счётчик
    // сообщений не идёт — в переписке его нет.
    expect(profile!.messagesIn).toBe(2);
    expect(profile!.clientId).toBe(clientId);
    // ФИО из карточки клиента побеждает имя из профиля мессенджера, и это то же
    // правило, по которому живёт живой код (звонок передаёт имя как названное
    // самим человеком, а имя из соцсети — только подсказка). Разбор обязан
    // повторять живой путь, а не решать по-своему.
    expect(profile!.displayName).toBe(`Хангома ${nameTag}`);
  });

  it("категория выведена из черновика и помечена как выведенная кодом", async () => {
    const conversation = await prisma.botConversation.findUnique({
      where: { id: createdConversations[0] },
      select: { contactProfileId: true },
    });
    const profile = await prisma.contactProfile.findUnique({
      where: { id: conversation!.contactProfileId! },
      select: { category: true, categoryHistory: true },
    });
    expect(profile!.category).toBe("BUYER");
    const history = parseContactCategoryHistory(profile!.categoryHistory);
    // «guard» — категорию вывел код по архиву, а не модель в разговоре. По
    // истории смен это обязано быть видно: иначе разбор не отличить от живого
    // разговора, которого не было.
    expect(history.at(-1)).toMatchObject({ category: "BUYER", source: "guard" });
  });

  it("повторный запуск второго досье не заводит", async () => {
    const before = await prisma.contactProfile.count();
    const stats = await backfillContactProfiles({ apply: true });
    const after = await prisma.contactProfile.count();
    expect(after).toBe(before);
    expect(stats.conversations).toBe(0);
    expect(stats.calls).toBe(0);
  });
});

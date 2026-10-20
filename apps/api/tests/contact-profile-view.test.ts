import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  identitiesForMessengerChannel,
  recordContactFacts,
  resolveContactProfile,
  setContactCategory,
} from "../src/lib/contactProfiles.js";
import { contactProfileView } from "../src/lib/contactProfileView.js";

/**
 * ДОСЬЕ ГЛАЗАМИ ЧЕЛОВЕКА — панель собеседника в «Чатах».
 *
 * Проверяется то, ради чего панель появилась, и то, чем её легче всего
 * испортить:
 *
 *  1. на экране печатаются ТЕ ЖЕ слова, что уходят в промт бота («бюджет от»,
 *     «покупка») — иначе владелец сверяет ответ бота не с тем, что бот читал;
 *  2. три гейта по правам (канал, телефон, кандидаты на слияние) держатся все
 *     сразу: каждый по отдельности сводит запрет на нет;
 *  3. досье нет — приходит null, а не пустой объект: пустые поля на экране
 *     читаются как «бот ничего не знает», а это другое утверждение.
 *
 * Номера одной длины из одной полосы и уборка за собой — известная ловушка
 * этого репозитория (столкновение идентификаторов между файлами и на повторе).
 */

const digits6 = String(Date.now()).slice(-6);
const WA_ID = `992915${digits6.slice(0, 3)}`;
const createdProfiles: string[] = [];

async function cleanup(): Promise<void> {
  const ids = new Set(createdProfiles);
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: [WA_ID] } },
    select: { profileId: true },
  });
  for (const row of rows) ids.add(row.profileId);
  const list = [...ids];
  if (list.length === 0) return;
  await prisma.contactLinkCandidate.deleteMany({
    where: { OR: [{ leftId: { in: list } }, { rightId: { in: list } }] },
  });
  await prisma.botConversation.deleteMany({ where: { OR: [{ subscriberId: WA_ID }, { contactProfileId: { in: list } }] } });
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: list } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: list } } });
}

const ALL_ALLOWED = { canSeeOrigin: true, canSeePhone: true, canMerge: true };
const AGENT = { canSeeOrigin: false, canSeePhone: false, canMerge: false };

let profileId = "";

beforeAll(async () => {
  await cleanup();
  const resolved = await resolveContactProfile({
    identities: identitiesForMessengerChannel("WHATSAPP", WA_ID),
    name: "Далер",
    nameSource: "profile",
  });
  expect(resolved).not.toBeNull();
  profileId = resolved!.profileId;
  createdProfiles.push(profileId);

  await setContactCategory({ profileId, category: "BUYER", source: "model" });
  await recordContactFacts({
    profileId,
    domain: "buyer",
    values: { intent: "buy", budgetMin: 50000, districtName: "Исмоили Сомони" },
    source: "model",
  });
});

afterAll(cleanup);

describe("досье для экрана", () => {
  it("печатает факты теми же словами, что уходят в промт бота", async () => {
    const view = await contactProfileView(profileId, ALL_ALLOWED);
    expect(view).not.toBeNull();
    const buyer = view!.facts.buyer;
    // «обращение: покупка» — ровно та подпись и тот перевод намерения, что
    // печатает contactProfileForPrompt. Разойдись они, владелец сверял бы ответ
    // бота не с тем, что бот прочитал.
    expect(buyer.find((f) => f.key === "intent")).toMatchObject({ label: "обращение", value: "покупка" });
    expect(buyer.find((f) => f.key === "budgetMin")).toMatchObject({ label: "бюджет от", value: "50000" });
    expect(view!.category).toBe("BUYER");
  });

  it("длину переписки считает Postgres, а не чтение всей истории в память", async () => {
    // Кладём три реплики в диалог и убеждаемся, что панель показывает 3, не
    // читая массив сообщений целиком: счёт идёт через jsonb_array_length.
    await prisma.botConversation.create({
      data: {
        channel: "WHATSAPP",
        subscriberId: WA_ID,
        contactProfileId: profileId,
        lastMessageAt: new Date(),
        messages: [
          { role: "user", content: "Салом", at: new Date().toISOString() },
          { role: "assistant", content: "Здравствуйте!", at: new Date().toISOString() },
          { role: "user", content: "Ищу двушку", at: new Date().toISOString() },
        ] as object,
      },
    });
    const view = await contactProfileView(profileId, ALL_ALLOWED);
    const wa = view!.conversations.find((c) => c.channel === "WHATSAPP");
    expect(wa).toBeTruthy();
    expect(wa!.messages).toBe(3);
  });

  it("без права «откуда клиент» не отдаёт ни канал, ни имя из профиля соцсети", async () => {
    const view = await contactProfileView(profileId, AGENT);
    expect(view).not.toBeNull();
    // Имя пришло из профиля мессенджера — тот же @ник, что прячет инбокс.
    expect(view!.displayName).toBeNull();
    expect(view!.channels.every((c) => c.channel === null)).toBe(true);
    expect(view!.conversations.every((c) => c.channel === null)).toBe(true);
  });

  it("без права на телефон отдаёт маску, а не номер", async () => {
    const full = await contactProfileView(profileId, ALL_ALLOWED);
    const masked = await contactProfileView(profileId, AGENT);
    expect(full!.primaryPhone).toContain(WA_ID.slice(-4));
    expect(masked!.primaryPhone).not.toContain(WA_ID.slice(-4));
    expect(masked!.phonesCount).toBe(full!.phonesCount);
  });

  it("кандидаты на слияние видны только с правом объединять дубликаты", async () => {
    const other = await resolveContactProfile({
      // Telegram общим хелпером не собирается (он знает только каналы Meta) —
      // признак ставится так же, как его ставит telegram/bot.ts.
      identities: [{ kind: "TG_CHAT_ID", value: `tgv-${digits6}`, trust: "TRANSPORT" }],
    });
    expect(other).not.toBeNull();
    createdProfiles.push(other!.profileId);
    await prisma.contactLinkCandidate.create({
      data: { leftId: profileId, rightId: other!.profileId, reason: "STATED_PHONE" },
    });

    const withRight = await contactProfileView(profileId, ALL_ALLOWED);
    expect(withRight!.pendingLinks).toHaveLength(1);
    expect(withRight!.pendingLinks[0].otherProfile.id).toBe(other!.profileId);

    const withoutRight = await contactProfileView(profileId, AGENT);
    expect(withoutRight!.pendingLinks).toHaveLength(0);
  });

  it("досье нет — null, а не пустое досье", async () => {
    expect(await contactProfileView(null, ALL_ALLOWED)).toBeNull();
    expect(await contactProfileView("00000000-0000-0000-0000-000000000000", ALL_ALLOWED)).toBeNull();
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { invalidateLeadMagnetCache, tryLeadMagnetMessage } from "../src/lib/leadMagnet.js";

/**
 * ИДЕМПОТЕНТНОСТЬ ШАГА «ПРОСИМ ПОДПИСАТЬСЯ» (CLAUDE.md, пункт 5 разведки
 * 22.09.2026, apps/api/src/lib/leadMagnet.ts:992-1008).
 *
 * До правки просьба подписаться уходила клиенту, и ТОЛЬКО ПОТОМ обновлялась
 * строка `leadMagnetDelivery` (state/followChecks/askedFollowAt). Между двумя
 * этими шагами не было замка — а именно так вебхук Meta и повторяет доставку
 * (второй HTTP-запрос параллельно первому, не следующий по очереди): оба запроса
 * читают одну и ту же ещё не обновлённую строку и оба отправляют просьбу
 * подписаться, прежде чем кто-то из них успевает её обновить. Человек получает
 * ту же просьбу дважды. Замок — тот же атомарный приём (условный `updateMany` по
 * `followChecks`), что уже стоит у `deliver()`/`tryRedeliver()` в этом файле.
 */

const runId = Date.now().toString(36);
const password = "testpass123";

let directorId = "";
let campaignId = "";

const IG_USER = `igsid-ask-${runId}`;

const savedIgToken = process.env.META_IG_TOKEN;
const savedPublicUrl = process.env.CRM_PUBLIC_URL;

let sent: { url: string; body: Record<string, unknown> }[] = [];

/**
 * Ворота на ответе профиля (GET) — общие для всех вызовов `fetch`, пока не
 * `undefined`. Держат ОБА параллельных `tryLeadMagnetMessage` в ожидании ровно
 * перед атомарным захватом (`updateMany` по `followChecks`), так что гонка на
 * замке воспроизводится детерминированно, а не зависит от того, как ровно
 * event loop и пул соединений Prisma (`connection_limit=3`) разложат по времени
 * два вызова `Promise.all` — без ворот они иногда успевают выполниться почти
 * последовательно, и тест перестаёт проверять именно гонку.
 */
let profileGate: Promise<void> | null = null;
/** Сколько вызовов уже упёрлось в ворота — по нему тест ждёт ИМЕННО обоих,
 *  а не фиксированные миллисекунды (те под нагрузкой не выдерживают). */
let profileGateArrivals = 0;

function stubMeta() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
      const address = String(url);
      if (!init?.method || init.method === "GET") {
        if (profileGate) {
          profileGateArrivals += 1;
          await profileGate;
        }
        // Профиль: человек твёрдо НЕ подписан — ветка «просим» должна сработать.
        const body = JSON.stringify({ username: `client_${runId}`, is_user_follow_business: false });
        return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response;
      }
      sent.push({ url: address, body: JSON.parse(String(init?.body ?? "{}")) });
      const ok = JSON.stringify({ message_id: `mid-${sent.length}` });
      return { ok: true, status: 200, text: async () => ok, json: async () => JSON.parse(ok) } as unknown as Response;
    })
  );
}

/** Только исходящие с кнопкой «подписаться» — карточка или quick reply просьбы. */
function followAsks() {
  return sent.filter((s) => {
    const message = (s.body as { message?: Record<string, unknown> }).message ?? {};
    const quick = (message.quick_replies as { title: string }[] | undefined) ?? [];
    const attachment = message.attachment as
      | { payload?: { elements?: { buttons?: { title: string }[] }[] } }
      | undefined;
    const cardButtons = attachment?.payload?.elements?.[0]?.buttons ?? [];
    return [...quick, ...cardButtons].some((b) => b.title === CAMPAIGN.followButton);
  });
}

const CAMPAIGN = {
  name: `Тест-воронка-ask ${runId}`,
  enabled: true,
  keywords: ["ЧЕКЛИСТ"],
  publicReplies: ["Отправил в директ"],
  inviteText: "Чек-лист готов — нажмите кнопку",
  inviteButton: "Хочу чек-лист",
  requireFollow: true,
  followText: "Подпишитесь и нажмите кнопку",
  followButton: "Я подписался",
  notFollowingText: "Подписки пока не вижу",
  maxFollowChecks: 3,
  deliverIfUnsure: false,
  deliveredText: "Готово, вот чек-лист",
  link: "https://royalhome.tj/checklist",
  handoffToBot: true,
};

beforeAll(async () => {
  process.env.META_IG_TOKEN = "test-ig-token";
  process.env.CRM_PUBLIC_URL = "https://crm.test";
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: "Тест Директор ask", phone: `+992963${runId}`, role: "DIRECTOR", passwordHash },
  });
  directorId = director.id;
});

afterAll(async () => {
  await prisma.leadMagnetCampaign.deleteMany({ where: { name: { startsWith: "Тест-воронка-ask" } } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  if (savedIgToken === undefined) delete process.env.META_IG_TOKEN;
  else process.env.META_IG_TOKEN = savedIgToken;
  if (savedPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL;
  else process.env.CRM_PUBLIC_URL = savedPublicUrl;
});

beforeEach(async () => {
  sent = [];
  profileGate = null;
  stubMeta();
  await prisma.outboundShieldState.deleteMany({ where: { subscriberId: IG_USER } });
  const campaign = await prisma.leadMagnetCampaign.create({ data: CAMPAIGN });
  campaignId = campaign.id;
  invalidateLeadMagnetCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await prisma.leadMagnetDelivery.deleteMany({ where: { campaignId } });
  await prisma.leadMagnetCampaign.deleteMany({ where: { id: campaignId } });
  await prisma.botConversation.deleteMany({ where: { subscriberId: IG_USER } });
  await prisma.outboundShieldState.deleteMany({ where: { channel: "INSTAGRAM", subscriberId: IG_USER } });
  invalidateLeadMagnetCache();
});

describe("Просьба подписаться не дублируется", () => {
  it("два параллельных хода на одну и ту же ступень отправляют ОДНУ просьбу", async () => {
    // Строка воронки уже на ступени «пригласили» — как будто первое сообщение
    // (клик по кнопке приглашения) уже обработано где-то раньше.
    const delivery = await prisma.leadMagnetDelivery.create({
      data: { campaignId, igUserId: IG_USER, username: `client_${runId}`, state: "INVITED", followChecks: 0 },
    });

    // Meta повторяет доставку вторым HTTP-запросом ПАРАЛЛЕЛЬНО первому, а не
    // следующим по очереди. Ворота на профиле держат оба вызова прямо перед
    // атомарным захватом, пока не отпущены разом, — так гонка воспроизводится
    // детерминированно, а не зависит от случайного расклада event loop/пула
    // соединений Prisma.
    let releaseGate: () => void = () => {};
    profileGateArrivals = 0;
    profileGate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const callA = tryLeadMagnetMessage({ channel: "INSTAGRAM", senderId: IG_USER, text: "ещё не подписался" });
    const callB = tryLeadMagnetMessage({ channel: "INSTAGRAM", senderId: IG_USER, text: "ещё не подписался" });
    // Ждём, пока в ворота упрутся ОБА вызова, и только потом отпускаем. Раньше
    // тут стояла пауза в 20 мс, и на загруженной машине второй вызов не успевал
    // дойти: первый проходил круг целиком, второй читал уже сдвинутую строку и
    // слал законный ПОВТОРНЫЙ запрос — тест краснел на чужих правках, хотя
    // защита от дубля цела. Класс «тест наперегонки», CLAUDE.md.
    const bothArrived = Date.now() + 5000;
    while (profileGateArrivals < 2 && Date.now() < bothArrived) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(profileGateArrivals).toBe(2);
    releaseGate();
    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toBe(true);
    expect(b).toBe(true);

    // Главная проверка: человек получил ОДНУ просьбу подписаться, а не две.
    expect(followAsks().length).toBe(1);

    const after = await prisma.leadMagnetDelivery.findUnique({ where: { id: delivery.id } });
    expect(after?.state).toBe("AWAITING_FOLLOW");
    expect(after?.followChecks).toBe(1);
  });

  it("настоящий следующий круг (после провала отправки) может попросить снова", async () => {
    // Не превращаем замок в вечный: после того как первая попытка честно
    // откатилась (см. releaseProcessedMessage/откат followChecks в коде), тот же
    // человек должен получить возможность попросить ещё раз в СЛЕДУЮЩЕМ ходе.
    const delivery = await prisma.leadMagnetDelivery.create({
      data: { campaignId, igUserId: IG_USER, username: `client_${runId}`, state: "INVITED", followChecks: 0 },
    });

    const first = await tryLeadMagnetMessage({ channel: "INSTAGRAM", senderId: IG_USER, text: "не подписался" });
    expect(first).toBe(true);
    expect(followAsks().length).toBe(1);

    const second = await tryLeadMagnetMessage({ channel: "INSTAGRAM", senderId: IG_USER, text: "всё ещё нет" });
    expect(second).toBe(true);
    expect(followAsks().length).toBe(2);

    const after = await prisma.leadMagnetDelivery.findUnique({ where: { id: delivery.id } });
    expect(after?.followChecks).toBe(2);
  });
});

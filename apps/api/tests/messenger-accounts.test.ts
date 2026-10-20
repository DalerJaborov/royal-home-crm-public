import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSettled } from "./helpers/waitFor.js";
import { prisma } from "../src/db.js";
import { instagramTokenIdentity, parseIncoming } from "../src/messengers/meta.js";
import {
  accountPersona,
  deleteAccount,
  listAccounts,
  resolveIncomingAccount,
  resetAccountsCache,
  resetRecipientLearning,
  saveAccount,
} from "../src/messengers/accounts.js";
import { ensureConversationId } from "../src/messengers/conversation.js";

/**
 * Несколько аккаунтов на канал: кто написал — тому и отвечаем.
 *
 * Цена ошибки здесь не «неудобно», а «человек написал в Royal Home Info, а ответ
 * пришёл от основного аккаунта» — то есть переписка ушла не туда и выглядит как
 * взлом. Поэтому проверяется вся цепочка: получатель вынимается из вебхука,
 * по нему находится аккаунт, а незнакомый получатель не роняет ответ вовсе.
 */

const IG_MAIN = "17841400000001";
const IG_INFO = "17841400000002";
/**
 * Идентификатор в области приложения — тот, что показывает панель Meta и что
 * возвращает `GET /me?fields=id`. В вебхуке приходит НЕ он (см. IG_INFO выше),
 * и именно на этой подмене 15.08.2026 вся переписка второго аккаунта уходила
 * маркером первого.
 */
const IG_INFO_APP_SCOPED = "37490400000002";

async function clearAccounts() {
  await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: "test-multi-" } } });
  await prisma.messengerAccount.deleteMany({
    where: { externalId: { in: [IG_MAIN, IG_INFO, IG_INFO_APP_SCOPED] } },
  });
  resetAccountsCache();
  resetRecipientLearning();
}

beforeEach(async () => {
  await clearAccounts();
  /**
   * Сеть в тестах закрыта по умолчанию.
   *
   * Незнакомый получатель теперь идёт сверять идентификаторы с Meta
   * (reconcileInstagramAccountIds), и без заглушки два теста ниже уходили в
   * настоящий graph.instagram.com: прогон становился зависимым от интернета и
   * занимал десять секунд вместо одной. Тесты, которым Meta нужна, ставят свою
   * заглушку поверх этой.
   */
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("сеть в тестах закрыта");
    })
  );
});
afterEach(() => vi.unstubAllGlobals());
// Убираем за собой и ПОСЛЕ последнего теста, а не только перед каждым: оставшийся
// аккаунт меняет поведение чужих тестов, которые ходят в ту же базу (отправка
// начинает искать маркер аккаунта вместо маркера из Settings). Ровно на этом
// voice-delivery.test.ts был зелёным локально и красным в CI.
afterAll(clearAccounts);

describe("разбор вебхука", () => {
  it("вынимает получателя: в какой наш аккаунт написали", () => {
    const body = {
      object: "instagram",
      entry: [
        {
          id: IG_INFO,
          messaging: [{ sender: { id: "client-1" }, recipient: { id: IG_INFO }, message: { mid: "m1", text: "Здравствуйте" } }],
        },
      ],
    };
    const parsed = parseIncoming(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].accountExternalId).toBe(IG_INFO);
  });

  it("у WhatsApp получатель — идентификатор номера", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "555" },
                contacts: [{ wa_id: "992900000000", profile: { name: "Клиент" } }],
                messages: [{ id: "wm1", from: "992900000000", type: "text", text: { body: "Привет" } }],
              },
            },
          ],
        },
      ],
    };
    const parsed = parseIncoming(body, "555");
    expect(parsed[0]?.accountExternalId).toBe("555");
  });
});

describe("выбор аккаунта для ответа", () => {
  it("без заведённых аккаунтов работает по-старому, на настройках", async () => {
    const account = await resolveIncomingAccount("INSTAGRAM", IG_INFO);
    expect(account.id).toBeNull();
  });

  it("находит аккаунт по получателю", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main" });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "token-info" });

    const main = await resolveIncomingAccount("INSTAGRAM", IG_MAIN);
    const info = await resolveIncomingAccount("INSTAGRAM", IG_INFO);

    expect(main.title).toBe("Royal Home");
    expect(main.token).toBe("token-main");
    expect(info.title).toBe("Royal Home Info");
    expect(info.token).toBe("token-info");
  });

  // Незнакомый получатель — это новый аккаунт, который забыли завести, или смена
  // идентификатора у Meta. Молчать в ответ нельзя: человек ждёт ответа.
  it("незнакомому получателю отвечает аккаунт по умолчанию, а не тишина", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    const account = await resolveIncomingAccount("INSTAGRAM", "17841400000999");
    expect(account.token).toBe("token-main");
  });

  it("первый заведённый аккаунт канала сам становится основным", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main" });
    const list = await listAccounts("INSTAGRAM");
    expect(list.find((a) => a.externalId === IG_MAIN)?.isDefault).toBe(true);
  });

  // Два основных аккаунта — это два разных ответа на одно и то же входящее,
  // и разбираться пришлось бы по журналам.
  it("основной аккаунт всегда ровно один", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "t1", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "t2", isDefault: true });

    const list = await listAccounts("INSTAGRAM");
    expect(list.filter((a) => a.isDefault)).toHaveLength(1);
    expect(list.find((a) => a.isDefault)?.externalId).toBe(IG_INFO);
  });

  it("после удаления основного канал не остаётся без основного", async () => {
    const mainId = await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "t1", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "t2" });

    await deleteAccount(mainId);

    const list = await listAccounts("INSTAGRAM");
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
  });

  it("выключенный аккаунт не подменяет собой основной", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "t1", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "t2", enabled: false });

    const unknown = await resolveIncomingAccount("INSTAGRAM", "17841400000777");
    expect(unknown.title).toBe("Royal Home");
  });

  it("маркер наружу не отдаётся — только признак, что он задан", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "секрет" });
    const list = await listAccounts("INSTAGRAM");
    expect(list[0].hasToken).toBe(true);
    expect(JSON.stringify(list)).not.toContain("секрет");
  });
});

/**
 * ДВА ИДЕНТИФИКАТОРА У ОДНОГО АККАУНТА Instagram (15.08.2026).
 *
 * `GET /me` возвращает и `id` (область приложения, его же показывает панель Meta),
 * и `user_id` (IG User ID). В `entry[].id` вебхука приходит ВТОРОЙ. Подключение
 * аккаунта брало первый — и оба аккаунта агентства записались идентификатором,
 * который не совпадает ни с одним входящим: переписка Royal Home Info полгода
 * отвечалась бы маркером и промтом основного аккаунта.
 *
 * Тесты выше этого не ловили: они кладут в базу сразу верный идентификатор, минуя
 * Meta. Поэтому здесь проверяется именно стык с ответом Meta.
 */
describe("идентификатор аккаунта из маркера", () => {
  afterEach(resetAccountsCache);

  function stubMe(body: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  }

  it("берёт user_id — то, чем Meta помечает получателя в вебхуке", async () => {
    stubMe({ id: IG_INFO_APP_SCOPED, user_id: IG_INFO, username: "royalhome.info" });
    const identity = await instagramTokenIdentity("маркер");
    expect(identity.ok).toBe(true);
    expect(identity.ok && identity.id).toBe(IG_INFO);
  });

  // У маркеров Страницы Facebook поля user_id нет вовсе — там верный ответ как раз id.
  it("без user_id возвращает id, а не отказ", async () => {
    stubMe({ id: IG_INFO_APP_SCOPED, username: "royalhome.info" });
    const identity = await instagramTokenIdentity("маркер");
    expect(identity.ok && identity.id).toBe(IG_INFO_APP_SCOPED);
  });

  /**
   * Записи, заведённые до исправления, уже лежат в базе с неверным идентификатором.
   * Пересохранить их владелец не может: маркер наружу не отдаётся, и в форме его
   * нет. Поэтому первое же непонятное входящее обязано починить данные само.
   */
  it("незнакомый получатель чинит устаревший идентификатор и попадает в свой аккаунт", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO_APP_SCOPED, title: "Royal Home Info", token: "token-info" });

    // Meta отвечает по маркеру: каждый аккаунт узнаёт свой настоящий user_id.
    // Маркер уходит либо заголовком (напрямую), либо параметром запроса (через
    // прокси, см. instagramRequest) — смотрим оба места, иначе тест зависел бы
    // от того, задан ли прокси в окружении.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        const sent = `${decodeURIComponent(String(url))} ${init?.headers?.Authorization ?? ""}`;
        const forInfo = sent.includes("token-info");
        return new Response(
          JSON.stringify(
            forInfo
              ? { id: IG_INFO_APP_SCOPED, user_id: IG_INFO, username: "royalhome.info" }
              : { id: "36982400000001", user_id: IG_MAIN, username: "royal.home.tj" }
          ),
          { status: 200 }
        );
      })
    );

    const account = await resolveIncomingAccount("INSTAGRAM", IG_INFO);

    // До исправления здесь оказывался «Royal Home» — основной аккаунт канала.
    expect(account.title).toBe("Royal Home Info");
    expect(account.token).toBe("token-info");
    // Починка записана в базу, а не только применена на лету.
    expect((await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home Info")?.externalId).toBe(IG_INFO);
  });

  // Meta недоступна — клиент всё равно должен получить ответ, пусть и основным аккаунтом.
  it("отказ Meta не оставляет клиента без ответа", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      })
    );

    const account = await resolveIncomingAccount("INSTAGRAM", "17841400000999");
    expect(account.title).toBe("Royal Home");
    expect(account.token).toBe("token-main");
  });
});

/**
 * ТРЕТИЙ ИДЕНТИФИКАТОР, КОТОРЫЙ МЕТА НЕ ПОДТВЕРДИТ (22.08.2026, «Royal Home Info»).
 *
 * Живой случай: получатель во входящем — 873975375804470 — не совпал НИ С
 * externalId (17841438971591101), НИ С messagingId (37490489683927632), хотя
 * reconcileInstagramAccountIds честно сверялся с Meta шесть раз за два дня.
 * Так и должно быть: `GET /me?fields=id,user_id,username` отдаёт РОВНО два
 * идентификатора этого аккаунта, а получатель — из третьего пространства
 * (похоже на ID связанной Страницы Facebook, см. schema.prisma), которое этим
 * запросом не увидеть в принципе — самопочинка тут бессильна не из-за бага, а
 * потому что спросить Meta больше не о чем.
 *
 * Поэтому у аккаунта есть extraExternalIds — список, который заполняет человек
 * руками, взяв идентификатор прямо из текста ошибки «неизвестный получатель».
 */
describe("третий идентификатор — руками, Meta его не подтверждает", () => {
  const THIRD_ID = "873975375804470";

  it("после ручного добавления получатель находит свой аккаунт без ошибки в журнале", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "token-info" });
    // Добавляем третий идентификатор ПОСЛЕ создания — ровно так, как это сделает
    // владелец из формы, скопировав число из журнала ошибок.
    const infoId = (await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home Info")!.id;
    await saveAccount({ id: infoId, channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", extraExternalIds: [THIRD_ID] });

    // ОБА замера через waitForSettled: messengers/accounts.ts пишет в журнал
    // через `void logSystemError`, и хвост предыдущего теста файла приземлился бы
    // между снимками (класс «тест наперегонки с записью в отрыве»).
    const countOwn = () =>
      prisma.errorLog.count({ where: { source: "meta", message: { contains: THIRD_ID } } });
    const before = await waitForSettled(countOwn);
    const account = await resolveIncomingAccount("INSTAGRAM", THIRD_ID);
    const after = await waitForSettled(countOwn);

    expect(account.title).toBe("Royal Home Info");
    expect(account.token).toBe("token-info");
    // Найден точным совпадением — ни разу не постучались в reconcile/Meta и не
    // записали «неизвестный получатель» в журнал.
    expect(after).toBe(before);
  });

  it("сверка с Meta (два известных ей идентификатора) сама этот случай не чинит", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "token-info" });

    // Meta отвечает ЧЕСТНО и верно — теми же двумя идентификаторами, что уже
    // записаны. Третьего поля в её ответе нет и быть не может: reconcile не
    // ошибается, ему просто не с чем сверить получателя.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: IG_INFO_APP_SCOPED, user_id: IG_INFO, username: "royalhome.info" }), { status: 200 }))
    );

    const account = await resolveIncomingAccount("INSTAGRAM", THIRD_ID);

    // До ручного добавления — как и в проде 21–22.08.2026 — отвечает основной.
    expect(account.title).toBe("Royal Home");
    const stillUnmatched = (await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home Info");
    expect(stillUnmatched?.externalId).toBe(IG_INFO);
    expect(stillUnmatched?.extraExternalIds).toEqual([]);
  });
});

/**
 * Свой промт у аккаунта (15.08.2026).
 *
 * Royal Home Info ведёт советы, чек-листы и вакансии, основной аккаунт продаёт.
 * Общий промт на оба означал, что подписчик Info получает продающие вопросы там,
 * где просил чек-лист.
 */
describe("своя «личность» бота у аккаунта", () => {
  it("без своего промта аккаунт работает на общем", async () => {
    const id = await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "t1" });
    expect(await accountPersona(id)).toBeNull();
  });

  it("свой промт возвращается именно тому аккаунту, которому задан", async () => {
    const mainId = await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "t1" });
    const infoId = await saveAccount({
      channel: "INSTAGRAM",
      externalId: IG_INFO,
      title: "Royal Home Info",
      token: "t2",
      systemPrompt: "Ты ведёшь информационный аккаунт: советы и чек-листы.",
    });

    expect(await accountPersona(infoId)).toContain("информационный аккаунт");
    // Соседний аккаунт остаётся на общем промте — своя правка не расползается.
    expect(await accountPersona(mainId)).toBeNull();
  });

  it("пустая строка убирает свой промт, а не сохраняет пустой", async () => {
    const id = await saveAccount({
      channel: "INSTAGRAM",
      externalId: IG_INFO,
      title: "Royal Home Info",
      token: "t2",
      systemPrompt: "Свой текст",
    });
    expect(await accountPersona(id)).toBe("Свой текст");

    await saveAccount({ id, channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", systemPrompt: "" });
    expect(await accountPersona(id)).toBeNull();
  });

  it("правка названия не стирает уже заданный промт", async () => {
    const id = await saveAccount({
      channel: "INSTAGRAM",
      externalId: IG_INFO,
      title: "Royal Home Info",
      token: "t2",
      systemPrompt: "Свой текст",
    });
    // systemPrompt не передан вовсе — значит «не трогать».
    await saveAccount({ id, channel: "INSTAGRAM", externalId: IG_INFO, title: "Инфо-аккаунт" });
    expect(await accountPersona(id)).toBe("Свой текст");
  });

  it("диалога без аккаунта хватает, чтобы вернуться к общему промту", async () => {
    expect(await accountPersona(null)).toBeNull();
    expect(await accountPersona(undefined)).toBeNull();
  });
});

/**
 * ФИЛЬТР «ROYAL HOME INFO» ПУСТЕЛ (02.10.2026).
 *
 * Две дыры одного механизма «к какому нашему аккаунту относится переписка»:
 *  1. незнакомый получатель уходил основному аккаунту, и починить это мог только
 *     владелец руками (extraExternalIds) — теперь CRM спрашивает Meta, чей маркер
 *     видит написавшего, и запоминает получателя сама;
 *  2. одно такое письмо ПЕРЕПИСЫВАЛО аккаунт уже привязанной переписки, и она
 *     пропадала из фильтра своего аккаунта навсегда.
 */
describe("незнакомый получатель и привязка переписки", () => {
  const UNKNOWN = "873975375800002";
  const SENDER = "test-multi-sender-1";

  /** Meta: /me отвечает «честными» двумя идентификаторами (сверка ничего не чинит),
   *  профиль собеседника читается только маркером Info. */
  function stubMeta(seenBy: "token-info" | "token-main" | "both" | "nobody" | "error") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        const sent = `${decodeURIComponent(String(url))} ${init?.headers?.Authorization ?? ""}`;
        const forInfo = sent.includes("token-info");
        if (sent.includes("/me?")) {
          return new Response(
            JSON.stringify(forInfo ? { id: IG_INFO_APP_SCOPED, user_id: IG_INFO } : { id: "36982400000001", user_id: IG_MAIN }),
            { status: 200 }
          );
        }
        if (seenBy === "error") throw new Error("fetch failed");
        const sees = seenBy === "both" || (seenBy === "token-info" ? forInfo : seenBy === "token-main" ? !forInfo : false);
        return sees
          ? new Response(JSON.stringify({ username: "client" }), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "Object does not exist", error_subcode: 33 } }), { status: 400 });
      })
    );
  }

  async function twoAccounts() {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_INFO, title: "Royal Home Info", token: "token-info" });
  }

  it("узнаёт аккаунт по написавшему и запоминает получателя за ним", async () => {
    await twoAccounts();
    stubMeta("token-info");

    const account = await resolveIncomingAccount("INSTAGRAM", UNKNOWN, SENDER);
    expect(account.title).toBe("Royal Home Info");
    expect(account.token).toBe("token-info");
    expect(account.certain).toBe(true);

    const info = (await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home Info");
    expect(info?.extraExternalIds).toEqual([UNKNOWN]);

    // Дальше — точным совпадением, без единого запроса к Meta.
    const fetchMock = vi.fn(async () => {
      throw new Error("не должно звать Meta");
    });
    vi.stubGlobal("fetch", fetchMock);
    resetAccountsCache();
    const again = await resolveIncomingAccount("INSTAGRAM", UNKNOWN, "test-multi-other");
    expect(again.title).toBe("Royal Home Info");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("видят оба, не видит никто или Meta не ответила — не гадает", async () => {
    for (const mode of ["both", "nobody", "error"] as const) {
      await clearAccounts();
      await twoAccounts();
      stubMeta(mode);
      const account = await resolveIncomingAccount("INSTAGRAM", UNKNOWN, SENDER);
      expect(account.title, mode).toBe("Royal Home");
      expect(account.certain, mode).toBe(false);
      const all = await listAccounts("INSTAGRAM");
      expect(all.every((a) => a.extraExternalIds.length === 0), mode).toBe(true);
    }
  });

  it("без написавшего — прежнее поведение: основной аккаунт, догадка", async () => {
    await twoAccounts();
    stubMeta("token-info");
    const account = await resolveIncomingAccount("INSTAGRAM", UNKNOWN);
    expect(account.title).toBe("Royal Home");
    expect(account.certain).toBe(false);
  });

  it("единственный аккаунт канала — не догадка", async () => {
    await saveAccount({ channel: "INSTAGRAM", externalId: IG_MAIN, title: "Royal Home", token: "token-main", isDefault: true });
    const account = await resolveIncomingAccount("INSTAGRAM", UNKNOWN);
    expect(account.certain).toBe(true);
  });

  async function bindingSnapshot(id: string) {
    const [conversation, inquiry] = await Promise.all([
      prisma.botConversation.findUniqueOrThrow({ where: { id }, select: {
        accountId: true, endpointScopeId: true, messages: true, leadDraft: true,
        contactProfileId: true, clientId: true, customerPropertyFocus: true, customerPropertyFocusRevision: true,
      } }),
      prisma.customerInquiry.findUniqueOrThrow({ where: { conversationId: id }, select: {
        endpointScopeId: true, peerId: true, conversationId: true,
        stateRevision: true, intentRevision: true, ownershipEpoch: true, bindingRevision: true,
        ownerMode: true, ownerAgentId: true, ownerToken: true, closedAt: true,
        publicState: true, claimedContact: true, actionIntents: true,
        legacyMemoryQuarantined: true, lastAcceptedEventKey: true, lastAcceptedOrder: true,
      } }),
    ]);
    return { conversation, inquiry };
  }

  it("догадка и другой аккаунт не переписывают привязку, историю и ревизии", async () => {
    await twoAccounts();
    const all = await listAccounts("INSTAGRAM");
    const mainId = all.find((a) => a.title === "Royal Home")!.id;
    const infoId = all.find((a) => a.title === "Royal Home Info")!.id;
    const peer = `test-multi-bound-${randomUUID()}`;
    const boundId = await ensureConversationId("INSTAGRAM", peer, undefined, infoId);
    await prisma.botConversation.update({ where: { id: boundId }, data: {
      messages: [{ role: "user", content: "Синтетическая история исходного аккаунта" }],
    } });
    const before = await bindingSnapshot(boundId);
    expect(before.conversation.accountId).toBe(infoId);
    expect(before.conversation.endpointScopeId).not.toBeNull();
    expect(before.inquiry.endpointScopeId).toBe(before.conversation.endpointScopeId);

    await expect(ensureConversationId("INSTAGRAM", peer, undefined, mainId, true))
      .rejects.toMatchObject({ reason: "account_unknown" });
    // Сохраняем исходный oracle: догадка не уводит диалог Info в основной аккаунт.
    expect((await prisma.botConversation.findUnique({ where: { id: boundId } }))?.accountId).toBe(infoId);
    expect(await bindingSnapshot(boundId)).toEqual(before);

    // Gate A не перепривязывает даже точно известный другой аккаунт: отдельный
    // scoped диалог с тем же peer станет доступен только после contract-cutover.
    await expect(ensureConversationId("INSTAGRAM", peer, undefined, mainId))
      .rejects.toMatchObject({ reason: "compat_collision" });
    expect(await bindingSnapshot(boundId)).toEqual(before);
    expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: peer } })).toBe(1);
  });

  it("точный аккаунт создаёт и повторно использует свежую scoped переписку", async () => {
    await twoAccounts();
    const mainId = (await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home")!.id;
    const peer = `test-multi-fresh-${randomUUID()}`;
    const id = await ensureConversationId("INSTAGRAM", peer, undefined, mainId);
    const before = await bindingSnapshot(id);
    expect(before.conversation.accountId).toBe(mainId);
    expect(before.conversation.endpointScopeId).not.toBeNull();
    expect(before.inquiry.endpointScopeId).toBe(before.conversation.endpointScopeId);
    expect(before.inquiry).toMatchObject({ ownerMode: "HOLD", legacyMemoryQuarantined: true,
      claimedContact: null, publicState: {}, actionIntents: {}, lastAcceptedEventKey: null, lastAcceptedOrder: null });
    expect(await ensureConversationId("INSTAGRAM", peer, undefined, mainId)).toBe(id);
    expect(await bindingSnapshot(id)).toEqual(before);
    expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: peer } })).toBe(1);
  });

  it("legacy NULL-account Instagram остаётся в карантине и не усыновляется догадкой", async () => {
    await twoAccounts();
    const mainId = (await listAccounts("INSTAGRAM")).find((a) => a.title === "Royal Home")!.id;
    const peer = `test-multi-legacy-${randomUUID()}`;
    // Настоящая mixed-version форма записи: scope не передан, account NULL.
    // Migration 500 сама назначает LEGACY_UNKNOWN/HOLD; не фабрикуем authority.
    const legacy = await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: peer,
      accountId: null, messages: [{ role: "user", content: "Синтетическая старая история" }] } });
    const before = await bindingSnapshot(legacy.id);
    expect(before.conversation.accountId).toBeNull();
    expect(before.conversation.endpointScopeId).not.toBeNull();
    const scope = await prisma.customerEndpointScope.findUniqueOrThrow({ where: { id: before.inquiry.endpointScopeId } });
    expect(scope).toMatchObject({ kind: "LEGACY_UNKNOWN", messengerAccountId: null });
    expect(before.inquiry).toMatchObject({ ownerMode: "HOLD", legacyMemoryQuarantined: true,
      claimedContact: null, publicState: {}, actionIntents: {}, lastAcceptedEventKey: null, lastAcceptedOrder: null });

    await expect(ensureConversationId("INSTAGRAM", peer, undefined, mainId, true))
      .rejects.toMatchObject({ reason: "account_unknown" });
    expect(await bindingSnapshot(legacy.id)).toEqual(before);
    await expect(ensureConversationId("INSTAGRAM", peer, undefined, mainId))
      .rejects.toMatchObject({ reason: "compat_collision" });
    expect(await bindingSnapshot(legacy.id)).toEqual(before);
    expect(await prisma.botConversation.count({ where: { channel: "INSTAGRAM", subscriberId: peer } })).toBe(1);
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * КАЖДЫЙ ПУТЬ ЗАПИСИ КЛИЕНТСКОЙ РЕПЛИКИ СОХРАНЯЕТ ФАЙЛ ИЛИ ПИШЕТ ПРИЧИНУ (26.11.2026).
 *
 * Класс поломки: прод 25–26.11, 8 файлов из 8 потеряно молча — сохранение (#428) подключили к старому
 * циклу и к ветке HELD, а реплику клиента пишут ещё ядро, удержанные до ACK, Telegram. Реплика писалась,
 * файл — нет, и ни один тест не краснел: каждый путь был зелёный сам за себя.
 *
 * Здесь две защиты:
 *  1. ПО КОДУ-ПЕРЕЧНЮ: файл src, который пишет реплику клиента в переписку, обязан быть в перечне ниже —
 *     либо среди «несёт файлы» (и тогда в нём стоит вызов единой двери), либо среди «файлов не бывает».
 *     Новый путь записи без решения — красный тест с названием файла.
 *  2. ПОВЕДЕНИЕ единой двери (sourcesFromIngressMedia) на настоящих разборах вебхука Meta.
 */

const SRC = path.resolve(__dirname, "../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "generated") walk(full, out); } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Пути, где реплика клиента с возможными файлами ложится в переписку → маркер единой двери в коде. */
const CARRIES_FILES: Record<string, string> = {
  "lib/customerQualifierLedger.ts": "keepIngressMediaInBackground", // ядро: подписанный вход → inbox-consume
  "lib/customerHeldMessage.ts": "keepIngressMediaInBackground", // удержанное до ACK
  "messengers/conversation.ts": "attachmentsLost", // старый цикл Meta (LEGACY)
  "messengers/telegramDirectMessages.ts": "lostAfterStore", // Telegram, личный чат
  "telegram/bot.ts": "lostAfterStore", // Telegram, бот
  "routes/webhooks.ts": "attachmentsLostBefore", // WhatsApp не отдал адрес файла — причина едет в старый цикл
};
/** Пути, где «role: user» пишется без файлов клиента (комментарии, заявки на работу, текстовые сервисные записи). */
const NO_FILES = new Set([
  "lib/askCandidatePhone.ts", "lib/backfillJobApplications.ts", "lib/conversationDelivery.ts", "lib/leadMagnet.ts", "messengers/comments.ts",
]);

describe("пути записи клиентской реплики", () => {
  const discovered = walk(SRC)
    .map((f) => path.relative(SRC, f).replaceAll("\\", "/"))
    .filter((rel) => {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      return /role: "user"/.test(text) && /appendConversationMessages|appendDirectConversationMessages|messages: \{|"messages"/.test(text);
    });

  it("каждый найденный путь записи есть в перечне (новый путь без решения про файлы не проходит)", () => {
    const known = new Set([...Object.keys(CARRIES_FILES), ...NO_FILES]);
    const unknown = discovered.filter((rel) => !known.has(rel));
    expect(unknown, `Новый путь записи реплики клиента: ${unknown.join(", ")}. Решите про файлы: добавьте сохранение (lib/customerInputMedia.ts) и впишите файл в CARRIES_FILES, либо в NO_FILES, если файлов тут не бывает.`).toEqual([]);
  });

  it.each(Object.entries(CARRIES_FILES))("%s вызывает единую дверь сохранения файла или пишет причину потери", (rel, marker) => {
    const text = fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(text, `${rel} перестал содержать «${marker}» — реплика клиента снова может терять файл молча`).toContain(marker);
  });

  it("основной путь ядра передаёт файлы входящего в запись реплики", () => {
    const text = fs.readFileSync(path.join(SRC, "lib/customerDmCoreContext.ts"), "utf8");
    expect(text).toMatch(/recordScopedCustomerInput\([\s\S]*?media: payload\.payload\.media/);
  });
});

const lookup = vi.hoisted(() => ({ result: null as unknown, calls: [] as string[] }));
vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/meta.js")>();
  return { ...actual, lookupWhatsAppMedia: vi.fn(async (id: string) => { lookup.calls.push(id); return lookup.result; }) };
});
vi.mock("../src/messengers/accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/messengers/accounts.js")>();
  return { ...actual, resolveIncomingAccount: vi.fn(async () => ({ id: null, title: "Основной", token: undefined })) };
});

const { parseIncoming } = await import("../src/messengers/meta.js");
const { sourcesFromIngressMedia } = await import("../src/lib/customerInputMedia.js");

function waBody(type: string, payload: Record<string, unknown>) {
  return { object: "whatsapp_business_account", entry: [{ id: "100", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "100", display_phone_number: "+992 918 999 999" }, contacts: [{ wa_id: "992900000001", profile: { name: "Synthetic" } }],
    messages: [{ from: "992900000001", id: `wamid.${type}`, timestamp: "1700000000", type, [type]: payload }] } }] }] };
}

describe("единая дверь: из записанного входящего — откуда качать", () => {
  // Типы WhatsApp с media_id: каждый должен дойти до скачивания, а не потеряться на разборе.
  it.each(["image", "audio", "video", "document", "sticker"])("WhatsApp %s с media_id скачивается через Graph", async (type) => {
    const [msg] = parseIncoming(waBody(type, { id: `media-${type}`, mime_type: "x/y" }), "100");
    expect(msg.mediaId).toBe(`media-${type}`);
    lookup.calls = []; lookup.result = { source: { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", headers: { Authorization: "Bearer x" } } };
    const out = await sourcesFromIngressMedia({ channel: "WHATSAPP", accountExternalId: "100", media: [{ kind: msg.attachmentType === "sticker" ? "unknown" : msg.attachmentType!, assetRef: msg.mediaId }] });
    expect(lookup.calls).toEqual([`media-${type}`]);
    expect(out.sources).toHaveLength(1);
    expect(out.lost).toEqual([]);
  });

  it("WhatsApp: Meta не отдала адрес файла — пометка с причиной, а не тишина", async () => {
    lookup.result = { source: null, reason: "no_key" };
    expect(await sourcesFromIngressMedia({ channel: "WHATSAPP", accountExternalId: "100", media: [{ kind: "image", assetRef: "m1" }] }))
      .toEqual({ sources: [], lost: [{ kind: "image", reason: "no_key" }] });
    lookup.result = { source: null, reason: "unavailable" };
    expect(await sourcesFromIngressMedia({ channel: "WHATSAPP", accountExternalId: "100", media: [{ kind: "audio", assetRef: "m2" }] }))
      .toEqual({ sources: [], lost: [{ kind: "audio", reason: "unavailable" }] });
  });

  it("Instagram/Messenger: файлы по адресу; страница публикации и геометка — не файл", async () => {
    const out = await sourcesFromIngressMedia({ channel: "INSTAGRAM", accountExternalId: "1", media: [
      { kind: "image", url: "https://scontent.cdninstagram.com/a.jpg" },
      { kind: "video", url: "https://scontent.cdninstagram.com/b.mp4" },
      { kind: "audio", url: "https://scontent.cdninstagram.com/c.mp4" },
      { kind: "document", url: "https://cdn.example/d.pdf" },
      { kind: "unknown", url: "https://scontent.cdninstagram.com/reel.mp4" }, // ig_reel с CDN: ролик клиента
      { kind: "unknown", url: "https://www.instagram.com/reel/Abc123/" }, // страница чужой публикации
      { kind: "unknown", url: "https://maps.example/loc" }, // геометка
      { kind: "share", url: "https://scontent.cdninstagram.com/preview.jpg" }, // картинка пересланного поста
    ] });
    expect(out.sources.map((s) => s.declaredKind ?? "-")).toEqual(["image", "video", "audio", "document", "-", "image"]);
    expect(out.lost).toEqual([]);
  });

  it("Файл заявлен, а адреса нет — пометка «канал не отдал файл»", async () => {
    const out = await sourcesFromIngressMedia({ channel: "FACEBOOK", media: [{ kind: "video" }, { kind: "image" }, { kind: "unknown" }] });
    expect(out.lost).toEqual([{ kind: "video", reason: "unavailable" }, { kind: "image", reason: "unavailable" }]);
  });
});

describe("lostAfterStore: скачали, но не записали — пометка, а не тишина", () => {
  it("добавляет к отказам загрузки недостающие после записи", async () => {
    const { lostAfterStore } = await import("../src/messengers/attachments.js");
    expect(lostAfterStore({ images: [1, 2], audios: [3], medias: [], lost: [{ kind: "video", reason: "too_big" }] }, 1))
      .toEqual([{ kind: "video", reason: "too_big" }, { kind: "file", reason: "failed" }, { kind: "file", reason: "failed" }]);
    expect(lostAfterStore({ images: [1], audios: [], medias: [] }, 1)).toEqual([]);
  });
});

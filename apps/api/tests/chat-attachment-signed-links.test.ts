import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import sharp from "sharp";
// Перекодировка в тестах ждёт до конца (кроме проверки «готовится»), чтобы ответ был детерминированным.
process.env.CHAT_MEDIA_PREPARE_WAIT_MS = "60000";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath, privateDirRoot } from "../src/lib/privateFiles.js";
import { attachmentLinkExpiry, chatAttachmentLinks, verifyAttachmentLink } from "../src/lib/chatAttachmentLinks.js";
import { cleanupDerivedChatMedia, derivedFailMarker } from "../src/lib/chatMediaDerived.js";
import { invalidateAgentAccess } from "../src/auth/middleware.js";
import { presentMessages } from "../src/lib/messageAttachments.js";

/**
 * Вложения переписки по подписанной ссылке (25.11.2026, жалоба владельца «фото и
 * видео приходят, но не открываются в CRM»).
 *
 * Проверяем то, что ломается по-своему:
 *   1. Ссылку получает ТОЛЬКО тот, кто открыл бы файл и старым путём (право +
 *      свой клиент или clients.viewAll) — подпись не расширяет доступ.
 *   2. Подпись привязана к файлу и сроку: подмена имени, срока, самой подписи — 403.
 *   3. Отдача годится тегам <img>/<video>: без заголовка Authorization, с Range (206),
 *      private-кэш, no-referrer.
 *   4. Миниатюра и версия для браузера (ogg→m4a, mov→mp4) делаются один раз;
 *      рубильник их выключает; уборка снимает копии без оригинала.
 */

const runId = Date.now();
const password = "testpass123";
const phone = (prefix: string) => `+9929${prefix}${String(runId).slice(-6)}`;

let agentToken: string;
let otherAgentToken: string;
let directorToken: string;
let managerToken: string;
let agentId: string;
let clientShortId: number;
let conversationId: string;
let photoFile: string;
let voiceFile: string;
let movFile: string | null = null;

const createdAgentIds: string[] = [];
const createdClientIds: string[] = [];
const createdConversationIds: string[] = [];
const createdFiles: string[] = [];

const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function ffmpegMake(args: string[], ext: string): Buffer {
  const out = path.join(os.tmpdir(), `signed-links-${runId}-${Math.random().toString(36).slice(2)}.${ext}`);
  execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return buf;
}

async function createAgent(fullName: string, phoneNo: string, role: "DIRECTOR" | "MANAGER" | "AGENT") {
  const agent = await prisma.agent.create({
    data: { fullName, phone: phoneNo, passwordHash: await bcrypt.hash(password, 10), role, isActive: true },
  });
  createdAgentIds.push(agent.id);
  const res = await request(app).post("/api/v1/auth/login").send({ phone: phoneNo, password });
  expect(res.status).toBe(200);
  return { id: agent.id, token: res.body.accessToken as string };
}

/** Адрес из ответа API → путь для supertest (тот же сервер). */
const local = (url: string) => url;

beforeAll(async () => {
  const agent = await createAgent(`Агент Ссылок ${runId}`, phone("61"), "AGENT");
  agentId = agent.id;
  agentToken = agent.token;
  otherAgentToken = (await createAgent(`Другой агент Ссылок ${runId}`, phone("62"), "AGENT")).token;
  directorToken = (await createAgent(`Директор Ссылок ${runId}`, phone("63"), "DIRECTOR")).token;
  managerToken = (await createAgent(`Руководитель Ссылок ${runId}`, phone("64"), "MANAGER")).token;

  const jpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#3366aa" } }).jpeg({ quality: 95 }).toBuffer();
  photoFile = (await savePrivateFile(jpeg, "image/jpeg"))!;
  const ogg = hasFfmpeg
    ? ffmpegMake(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-b:a", "24k"], "ogg")
    : Buffer.from(`ogg-${runId}`);
  voiceFile = (await savePrivateFile(ogg, "audio/ogg"))!;
  if (hasFfmpeg) {
    const mov = ffmpegMake(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-c:v", "mpeg4", "-f", "mov"], "mov");
    movFile = await savePrivateFile(mov, "video/quicktime");
    createdFiles.push(movFile!);
  }
  createdFiles.push(photoFile, voiceFile);

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент Ссылок ${runId}`,
      phone: `+99265${String(runId).slice(-7)}`,
      source: "WHATSAPP",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  createdClientIds.push(client.id);
  clientShortId = client.shortId;
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `sub-signed-${runId}`,
      name: `Диалог ссылок ${runId}`,
      clientId: client.id,
      lastMessageAt: new Date(),
      messages: [
        {
          role: "user",
          content: "[📷]",
          attachments: [
            { kind: "image", file: photoFile, mime: "image/jpeg" },
            { kind: "audio", file: voiceFile, mime: "audio/ogg" },
            ...(movFile ? [{ kind: "video", file: movFile, mime: "video/quicktime" }] : []),
          ],
        },
      ],
    },
  });
  createdConversationIds.push(conversation.id);
  conversationId = conversation.id;
});

afterAll(async () => {
  await prisma.settings.updateMany({ where: { id: "singleton" }, data: { chatMediaTranscodeEnabled: true } });
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
  for (const name of createdFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
  cleanupDerivedChatMedia();
});

async function cardAttachments(token: string) {
  const res = await request(app).get(`/api/v1/clients/${clientShortId}`).set("Authorization", `Bearer ${token}`);
  return { status: res.status, atts: (res.body.botConversation?.[0]?.messages?.[0]?.attachments ?? []) as Array<Record<string, string>> };
}

describe("Кому выдаётся подписанная ссылка", () => {
  it("агент в карточке СВОЕГО клиента получает src, thumb у фото и play у голосового", async () => {
    const { status, atts } = await cardAttachments(agentToken);
    expect(status).toBe(200);
    const photo = atts.find((a) => a.kind === "image")!;
    const voice = atts.find((a) => a.kind === "audio")!;
    expect(photo.src).toMatch(/^\/api\/v1\/attachments\/s\//);
    expect(photo.thumb).toContain("&v=t");
    expect(photo.play).toBeUndefined();
    expect(voice.play).toContain("&v=p");
  });

  it("директор в инбоксе получает ссылки (clients.viewAll)", async () => {
    const res = await request(app).get(`/api/v1/conversations/${conversationId}`).set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const att = res.body.messages[0].attachments[0];
    expect(att.src).toBeTruthy();
  });

  it("руководитель без права messages.viewAttachments не получает ни имени, ни ссылки", async () => {
    const res = await request(app).get(`/api/v1/conversations/${conversationId}`).set("Authorization", `Bearer ${managerToken}`);
    if (res.status === 200) {
      for (const att of res.body.messages[0].attachments) {
        expect(att.file).toBeNull();
        expect(att.src).toBeUndefined();
      }
    } else {
      expect([403, 404]).toContain(res.status);
    }
  });

  it("presentMessages без явного signedLinks ссылок не кладёт — забытая проверка не открывает файл", () => {
    const [m] = presentMessages([{ role: "user", content: "x", attachments: [{ kind: "image", file: photoFile, mime: "image/jpeg" }] }], true, true);
    expect(m.attachments?.[0].src).toBeUndefined();
    expect(m.attachments?.[0].file).toBe(photoFile);
  });

  it("чужому агенту карточка закрыта — ссылок он не видит", async () => {
    const { status, atts } = await cardAttachments(otherAgentToken);
    expect(status === 200 ? atts.every((a) => !a.src) : true).toBe(true);
  });

  it("клиент прислал, а сохранить не вышло — пометка lost видна всем, файла нет", () => {
    const [m] = presentMessages([{ role: "user", content: "x", attachments: [{ kind: "video", mime: "video/mp4", lost: "too_big" }] }], false);
    expect(m.attachments?.[0]).toMatchObject({ kind: "video", file: null, lost: "too_big" });
  });
});

describe("Отдача по подписи", () => {
  async function photoSrc() {
    const { atts } = await cardAttachments(agentToken);
    return atts.find((a) => a.kind === "image")!.src;
  }

  it("без заголовка Authorization: 200, тип, private-кэш короче подписи, no-referrer", async () => {
    const src = await photoSrc();
    const res = await request(app).get(local(src));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(res.headers["cache-control"]).toMatch(/^private, max-age=\d+$/);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers["cache-control"])![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(6 * 60 * 60);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("Range: отдаёт кусок с кодом 206 — перемотка видео и голосовых", async () => {
    const src = await photoSrc();
    const res = await request(app).get(local(src)).set("Range", "bytes=0-9");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toMatch(/^bytes 0-9\/\d+$/);
    expect(Number(res.headers["content-length"])).toBe(10);
  });

  it("подпись от одного файла к другому не подходит", async () => {
    const src = await photoSrc();
    const forged = src.replace(encodeURIComponent(photoFile), encodeURIComponent(voiceFile));
    expect((await request(app).get(local(forged))).status).toBe(403);
  });

  it("подменённая подпись, сдвинутый срок, срок дальше выдаваемого и просроченный — 403", async () => {
    const src = await photoSrc();
    const url = new URL(src, "http://x");
    const e = Number(url.searchParams.get("e"));
    const k = url.searchParams.get("k")!;
    const base = url.pathname;
    const a = url.searchParams.get("a")!;
    expect((await request(app).get(`${base}?a=${a}&e=${e}&k=${k.slice(0, -1)}${k.endsWith("A") ? "B" : "A"}`)).status).toBe(403);
    expect((await request(app).get(`${base}?a=${a}&e=${e + 60}&k=${k}`)).status).toBe(403);
    // Подпись одного сотрудника не годится от имени другого.
    expect((await request(app).get(`${base}?a=${createdAgentIds[1]}&e=${e}&k=${k}`)).status).toBe(403);
    // Подпись честная, но срок «через год» — такую сервер не выдаёт никогда.
    const far = attachmentLinkExpiry(Date.now() + 365 * 24 * 3600 * 1000);
    const farLinks = chatAttachmentLinks(photoFile, "image", "image/jpeg", agentId, Date.now() + 365 * 24 * 3600 * 1000)!;
    expect(verifyAttachmentLink(photoFile, agentId, far, new URL(farLinks.src, "http://x").searchParams.get("k")!)).toBe(false);
    // Выдана сутки назад — уже просрочена.
    const old = chatAttachmentLinks(photoFile, "image", "image/jpeg", agentId, Date.now() - 5 * 3600 * 1000)!;
    expect((await request(app).get(local(old.src))).status).toBe(403);
    expect((await request(app).get(base)).status).toBe(403);
  });

  it("старый путь с заголовком работает как раньше; чужому агенту — 403", async () => {
    const own = await request(app).get(`/api/v1/attachments/${photoFile}`).set("Authorization", `Bearer ${agentToken}`);
    expect(own.status).toBe(200);
    const other = await request(app).get(`/api/v1/attachments/${photoFile}`).set("Authorization", `Bearer ${otherAgentToken}`);
    expect(other.status).toBe(403);
  });
});

describe("Копии: миниатюра и версия для браузера", () => {
  it("миниатюра фото — webp, меньше оригинала, второй раз берётся готовой", async () => {
    const { atts } = await cardAttachments(agentToken);
    const thumb = atts.find((a) => a.kind === "image")!.thumb;
    const first = await request(app).get(local(thumb)).buffer(true);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(first.body as Buffer).metadata();
    expect(meta.width).toBe(480);
    expect((first.body as Buffer).length).toBeLessThan(fs.statSync(privateFilePath(photoFile)!).size);
    const derived = path.join(privateDirRoot(), "derived", `${photoFile}.t.webp`);
    const mtime = fs.statSync(derived).mtimeMs;
    await request(app).get(local(thumb));
    expect(fs.statSync(derived).mtimeMs).toBe(mtime);
  });

  it.skipIf(!hasFfmpeg)("голосовое ogg/opus → m4a (AAC), которое играет Safari", async () => {
    const { atts } = await cardAttachments(agentToken);
    const play = atts.find((a) => a.kind === "audio")!.play;
    const res = await request(app).get(local(play)).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    const probe = execFileSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path.join(privateDirRoot(), "derived", `${voiceFile}.p.m4a`)]).toString().trim();
    expect(probe).toBe("aac");
  }, 60_000);

  it.skipIf(!hasFfmpeg)("видео mov → mp4 H.264 с перемоткой (206)", async () => {
    const { atts } = await cardAttachments(agentToken);
    const play = atts.find((a) => a.kind === "video")!.play;
    const res = await request(app).get(local(play)).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    const ranged = await request(app).get(local(play)).set("Range", "bytes=0-99");
    expect(ranged.status).toBe(206);
    const probe = execFileSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path.join(privateDirRoot(), "derived", `${movFile}.p.mp4`)]).toString().trim();
    expect(probe).toBe("h264");
  }, 120_000);

  it("рубильник выключен — новой копии для браузера не делается, ответ 404 с причиной", async () => {
    await prisma.settings.upsert({ where: { id: "singleton" }, update: { chatMediaTranscodeEnabled: false }, create: { id: "singleton", chatMediaTranscodeEnabled: false } });
    try {
      // Отдельный файл, у которого копии ещё точно нет.
      const fresh = (await savePrivateFile(Buffer.from(`ogg-off-${runId}`), "audio/ogg"))!;
      createdFiles.push(fresh);
      const links = chatAttachmentLinks(fresh, "audio", "audio/ogg", agentId)!;
      const res = await request(app).get(local(links.play!));
      expect(res.status).toBe(404);
      expect(res.body.reason).toBe("disabled");
    } finally {
      await prisma.settings.updateMany({ where: { id: "singleton" }, data: { chatMediaTranscodeEnabled: true } });
    }
  });

  it("уборка снимает копию, когда оригинала больше нет, и не трогает живую", async () => {
    const victim = (await savePrivateFile(await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000" } }).jpeg().toBuffer(), "image/jpeg"))!;
    const links = chatAttachmentLinks(victim, "image", "image/jpeg", agentId)!;
    expect((await request(app).get(local(links.thumb!))).status).toBe(200);
    const derived = path.join(privateDirRoot(), "derived", `${victim}.t.webp`);
    expect(fs.existsSync(derived)).toBe(true);
    fs.rmSync(privateFilePath(victim)!);
    cleanupDerivedChatMedia();
    expect(fs.existsSync(derived)).toBe(false);
    // Живая копия (оригинал на месте) осталась.
    expect(fs.existsSync(path.join(privateDirRoot(), "derived", `${photoFile}.t.webp`))).toBe(true);
  });
});

describe("Ревью #428: пропуск без входа, очередь, лимит", () => {
  it("отключённый сотрудник: его подписанная ссылка гаснет сразу", async () => {
    const { atts } = await cardAttachments(agentToken);
    const src = atts.find((a) => a.kind === "image")!.src;
    await prisma.agent.update({ where: { id: agentId }, data: { isActive: false } });
    invalidateAgentAccess(agentId);
    try {
      expect((await request(app).get(local(src))).status).toBe(403);
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { isActive: true } });
      invalidateAgentAccess(agentId);
    }
    expect((await request(app).get(local(src))).status).toBe(200);
  });

  it("чужой агент: ни в /conversations/:id, ни в /groups ссылок на файлы чужого клиента нет", async () => {
    const single = await request(app).get(`/api/v1/conversations/${conversationId}`).set("Authorization", `Bearer ${otherAgentToken}`);
    if (single.status === 200) for (const m of single.body.messages) for (const a of m.attachments ?? []) expect(a.src).toBeUndefined();
    const client = await prisma.botConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { clientId: true } });
    const group = await request(app).get(`/api/v1/conversations/groups/client:${client.clientId}`).set("Authorization", `Bearer ${otherAgentToken}`);
    if (group.status === 200) for (const m of group.body.messages) for (const a of m.attachments ?? []) expect(a.src).toBeUndefined();
    // Свой агент в той же группе ссылки получает — проверка не «никому ничего».
    const own = await request(app).get(`/api/v1/conversations/groups/client:${client.clientId}`).set("Authorization", `Bearer ${agentToken}`);
    if (own.status === 200) expect(own.body.messages.some((m: { attachments?: Array<{ src?: string }> }) => m.attachments?.some((a) => a.src))).toBe(true);
  });

  it.skipIf(!hasFfmpeg)("копия ещё не готова — 503 с Retry-After, работа идёт в фоне, потом 200", async () => {
    const ogg = ffmpegMake(["-f", "lavfi", "-i", "sine=frequency=300:duration=2", "-c:a", "libopus", "-b:a", "24k"], "ogg");
    const fresh = (await savePrivateFile(ogg, "audio/ogg"))!;
    createdFiles.push(fresh);
    const play = chatAttachmentLinks(fresh, "audio", "audio/ogg", agentId)!.play!;
    process.env.CHAT_MEDIA_PREPARE_WAIT_MS = "0";
    try {
      const first = await request(app).get(local(play));
      expect(first.status).toBe(503);
      expect(first.headers["retry-after"]).toBe("5");
      let status = 503;
      for (let i = 0; i < 40 && status === 503; i++) {
        await new Promise((r) => setTimeout(r, 250));
        status = (await request(app).head(local(play))).status;
      }
      expect(status).toBe(200);
    } finally {
      process.env.CHAT_MEDIA_PREPARE_WAIT_MS = "60000";
    }
  }, 60_000);

  it.skipIf(!hasFfmpeg)("битый файл: неудача помечается на сутки, второй запрос не гонит ffmpeg заново", async () => {
    const broken = (await savePrivateFile(Buffer.from(`not-an-ogg-${runId}`), "audio/ogg"))!;
    createdFiles.push(broken);
    const play = chatAttachmentLinks(broken, "audio", "audio/ogg", agentId)!.play!;
    expect((await request(app).get(local(play))).status).toBe(422);
    const marker = derivedFailMarker(`${broken}.p.m4a`);
    expect(fs.existsSync(marker)).toBe(true);
    const mtime = fs.statSync(marker).mtimeMs;
    const t0 = Date.now();
    expect((await request(app).get(local(play))).status).toBe(422);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.statSync(marker).mtimeMs).toBe(mtime);
  }, 60_000);

  it("отметки неудачи у webm голосом и видео — разные файлы", () => {
    const n = "00000000-0000-0000-0000-000000000000.webm";
    expect(derivedFailMarker(`${n}.p.m4a`)).not.toBe(derivedFailMarker(`${n}.p.mp4`));
  });

  it("webm голосом: подсказка m=a, а не «видео» по расширению", () => {
    const links = chatAttachmentLinks("00000000-0000-0000-0000-000000000000.webm", "audio", "audio/webm", agentId)!;
    expect(links.play).toContain("m=a");
    const video = chatAttachmentLinks("00000000-0000-0000-0000-000000000000.webm", "video", "video/webm", agentId)!;
    expect(video.play).toContain("m=v");
  });

  it("лимит считает только неверные подписи: 320 честных запросов (в том числе кусками) — без 429", async () => {
    const { atts } = await cardAttachments(agentToken);
    const src = atts.find((a) => a.kind === "image")!.src;
    for (let i = 0; i < 320; i++) {
      const res = await request(app).get(local(src)).set("Range", "bytes=0-1");
      expect(res.status).toBe(206);
    }
  }, 120_000);

  it("подбор подписи упирается в потолок (429)", async () => {
    let last = 0;
    for (let i = 0; i < 305; i++) {
      last = (await request(app).get(`/api/v1/attachments/s/${photoFile}?a=${agentId}&e=1&k=AAAAAAAAAAAAAAAAAAAAAA`)).status;
    }
    expect(last).toBe(429);
  }, 120_000);
});

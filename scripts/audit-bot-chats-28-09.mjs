/**
 * РАЗБОР ПЕРЕПИСОК БОТА ЗА ПОСЛЕДНИЕ ДНИ — ТОЛЬКО ЧТЕНИЕ (28.09.2026).
 *
 * Просьба владельца после скриншота «Ман сохибхона»: проверить чаты за последние
 * дни и понять масштаб. Считает три класса ошибок, найденных в этот день:
 *
 *  1. СОБСТВЕННИК, КОТОРОМУ ОТВЕТИЛИ КАК ПОКУПАТЕЛЮ: клиент назвал себя хозяином
 *     (OWNER_CLAIM), а следующая реплика бота говорит о собственнике как о третьем
 *     лице («бо соҳиби хона», «торг с собственником», «после показа»).
 *  2. ДВОЙНОЙ ОТВЕТ: на одну реплику клиента бот ответил двумя ходами подряд
 *     (две записи бота между репликами клиента) либо попросил номер дважды.
 *  3. БОТ ПОВЕРХ ЧЕЛОВЕКА: после ответа вручную (из приложения — by.kind
 *     "manual", из CRM — "agent") бот написал сам в течение 12 часов.
 *
 * В базу НИЧЕГО НЕ ПИШЕТ. Имён и номеров клиентов в отчёте нет — только
 * идентификатор диалога, канал, время и цитаты реплик бота (по ним открыть
 * переписку в CRM: /messages?open=<id>).
 *
 * Запуск на сервере из корня репозитория (в контейнере API или рядом с .env):
 *   npx tsx scripts/audit-bot-chats-28-09.mjs            # 7 дней
 *   npx tsx scripts/audit-bot-chats-28-09.mjs --days=3   # 3 дня
 * Отчёт — в консоль и файлом bot-chats-audit.md в текущей папке (в git не класть).
 */
import "./_env.cjs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

import { prisma } from "../apps/api/src/db.js";
import { OWNER_CLAIM, ownerAsThirdParty } from "../apps/api/src/ai/intentDirectionGuard.js";
import { mentionsPhoneRequest } from "../apps/api/src/ai/replyGuards.js";

const days = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const HUMAN_WINDOW_MS = 12 * 60 * 60 * 1000;
const PAGE = 500;

const at = (m) => (m?.at ? new Date(m.at).getTime() : NaN);
const cut = (t) => String(t ?? "").replace(/\s+/g, " ").slice(0, 140);
const isBot = (m) => m.role === "assistant" && (!m.by || m.by.kind === "bot");
const isHuman = (m) => m.role === "assistant" && (m.by?.kind === "manual" || m.by?.kind === "agent");
// Показ фото/карточки — отдельная запись бота, но это не второй ответ.
const isShowcase = (m) => (m.attachments?.length ?? 0) > 0 || /^\[(?:📷|🏠)|^📍|^https?:\/\//u.test(m.content ?? "");

function scan(conv) {
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];
  const found = { owner: [], double: [], overHuman: [] };
  let ownerClaimed = false;
  let lastHumanAt = NaN;
  let botRun = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const t = at(m);
    if (m.role === "user") {
      if (OWNER_CLAIM.test(m.content ?? "")) ownerClaimed = true;
      botRun = [];
      continue;
    }
    if (isHuman(m)) {
      lastHumanAt = t;
      botRun = [];
      continue;
    }
    if (!isBot(m) || !(t >= since.getTime())) continue;
    if (ownerClaimed && ownerAsThirdParty(m.content ?? "")) found.owner.push({ at: m.at, text: cut(m.content) });
    if (!isShowcase(m)) {
      botRun.push(m);
      const lines = String(m.content ?? "").split("\n").filter(mentionsPhoneRequest);
      if (botRun.length === 2 || lines.length >= 2) {
        found.double.push({ at: m.at, text: botRun.map((b) => cut(b.content)).join("  ||  ") });
      }
    }
    if (lastHumanAt && t - lastHumanAt >= 0 && t - lastHumanAt < HUMAN_WINDOW_MS) {
      found.overHuman.push({ at: m.at, minutesAfter: Math.round((t - lastHumanAt) / 60000), text: cut(m.content) });
      lastHumanAt = NaN;
    }
  }
  return found;
}

async function main() {
  const totals = { conversations: 0, owner: 0, double: 0, overHuman: 0 };
  const rows = { owner: [], double: [], overHuman: [] };
  let cursor;
  for (;;) {
    const page = await prisma.botConversation.findMany({
      where: { lastMessageAt: { gte: since } },
      select: { id: true, channel: true, messages: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    for (const conv of page) {
      totals.conversations++;
      const f = scan(conv);
      for (const k of ["owner", "double", "overHuman"]) {
        if (f[k].length === 0) continue;
        totals[k]++;
        rows[k].push({ id: conv.id, channel: conv.channel, items: f[k] });
      }
    }
    cursor = page[page.length - 1].id;
  }

  const lines = [
    `# Разбор переписок бота за ${days} дн. (с ${since.toISOString().slice(0, 10)})`,
    "",
    `Диалогов просмотрено: ${totals.conversations}`,
    `Собственнику ответили как покупателю: ${totals.owner}`,
    `Двойной ответ / две просьбы номера подряд: ${totals.double}`,
    `Бот написал после ручного ответа (до 12 ч): ${totals.overHuman}`,
  ];
  const section = (title, list, fmt) => {
    lines.push("", `## ${title}`, "");
    for (const r of list) {
      lines.push(`- ${r.channel} /messages?open=${r.id}`);
      for (const it of r.items.slice(0, 3)) lines.push(`  - ${fmt(it)}`);
    }
  };
  section("Собственнику ответили как покупателю", rows.owner, (it) => `${it.at}: ${it.text}`);
  section("Двойной ответ", rows.double, (it) => `${it.at}: ${it.text}`);
  section("Бот поверх человека", rows.overHuman, (it) => `${it.at} (через ${it.minutesAfter} мин): ${it.text}`);

  const out = resolve(process.cwd(), "bot-chats-audit.md");
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.slice(0, 7).join("\n"));
  console.log(`\nПодробно: ${out}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * ПЕРЕВЕСТИ ВИСЯЩИЕ ПРОСЬБЫ О ЗВОНКЕ В ОБЫЧНЫЕ ЗАЯВКИ (разовый, 23.08.2026).
 *
 * Предыстория. Просьба «перезвоните мне» жила отдельной сущностью: своя таблица,
 * свой push, плашка на главной и авто-соединение через АТС. Дежурного оператора на
 * деле нет, авто-соединение не срабатывает, и просьбы висели у руководства перед
 * глазами по двое суток, пока не протухали. Владелец 23.08.2026 решил: пока нет
 * колл-центра, такие обращения идут агентам как любые другие — рубильник Настройки →
 * Бот → «Соединять с оператором» выключен, плашки нет (см. ai/callbackRequest.ts).
 *
 * Зачем скрипт. Выключение рубильника гасит плашку — вместе с теми просьбами,
 * которые в ней сейчас висят. Люди из них никуда не делись и ответа ждут. Скрипт
 * доводит их до конца тем же путём, которым теперь пойдут новые: обычной заявкой.
 *
 * Что делает с каждой незакрытой просьбой:
 *  · КАРТОЧКА УЖЕ ЕСТЬ (обычный случай: человек давно наш клиент) → пометка прямо в
 *    требования карточки плюс push назначенному агенту. Гонять такую просьбу через
 *    createLeadFromChannel бессмысленно и вредно: resumeExistingChannelLead
 *    requirementsNotes НЕ дописывает — пометка молча потерялась бы, — а звонить
 *    всё равно тому же агенту, который у карточки уже есть;
 *  · карточки нет, но есть телефон → createLeadFromChannel, как при любом обращении
 *    из мессенджера: заводится карточка и распределяется агенту общим порядком;
 *  · нет ни того, ни другого → НЕ закрываем и печатаем в отчёт: звонить некуда,
 *    и тихо гасить такую просьбу нельзя — с человеком надо дописаться в переписке.
 *
 * Закрытые просьбы получают doneAt, но doneById остаётся пустым: закрыл не человек,
 * а перенос — путать это с работой агента нельзя (то же правило, что у
 * closeSettledCallbackRequests).
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/callback-requests-to-leads.ts            — показать, что будет сделано
 *     npx tsx scripts/callback-requests-to-leads.ts --apply    — выполнить
 */

import "../src/loadEnv.js";
import { prisma } from "../src/db.js";
import { createLeadFromChannel } from "../src/leads.js";
import { sendPushToAgent } from "../src/push.js";
import type { ClientSource } from "../src/generated/prisma/client.js";

const APPLY = process.argv.includes("--apply");

/** Источник по каналу просьбы — тот же выбор, что в messengers/conversation.ts:
 *  канала, которого нет в справочнике, быть не должно, но падать из-за него незачем. */
const SOURCES: readonly string[] = ["INSTAGRAM", "WHATSAPP", "FACEBOOK", "TELEGRAM"];
const toSource = (channel: string): ClientSource =>
  (SOURCES.includes(channel) ? channel : "WALK_IN") as ClientSource;

async function main(): Promise<void> {
  const open = await prisma.callbackRequest.findMany({
    where: { doneAt: null },
    orderBy: { requestedAt: "asc" },
  });
  if (open.length === 0) {
    console.log("Незакрытых просьб о звонке нет — переносить нечего.");
    return;
  }
  console.log(`Незакрытых просьб: ${open.length}${APPLY ? "" : " (пробный прогон, --apply не указан)"}\n`);

  let toLead = 0;
  let toNote = 0;
  let skipped = 0;

  for (const request of open) {
    const client = request.clientId
      ? await prisma.client.findUnique({
          where: { id: request.clientId },
          select: {
            id: true,
            shortId: true,
            fullName: true,
            phone: true,
            requirementsNotes: true,
            assignedAgentId: true,
          },
        })
      : null;
    const phone = request.phone?.trim() || client?.phone?.trim() || null;
    const note = `📞 ПРОСИТ ПЕРЕЗВОНИТЬ: ${request.topic}`;
    const when = request.requestedAt.toISOString().slice(0, 16).replace("T", " ");
    const who = client ? `${client.fullName} (№${client.shortId})` : "карточки нет";

    if (client) {
      console.log(
        `[пометка] ${when} · ${request.channel} · ${who} · ${phone ?? "телефона нет"} · ${request.topic}`
      );
      if (APPLY) {
        await prisma.client.update({
          where: { id: client.id },
          data: {
            requirementsNotes: [note, client.requirementsNotes].filter(Boolean).join("\n"),
          },
        });
        // Пометка в карточке молчит, пока агент её не открыл, — а человек ждёт
        // звонка. Push тому, за кем карточка закреплена; без агента карточку
        // разберёт руководство, которому она и так видна в списке.
        if (client.assignedAgentId) {
          await sendPushToAgent(client.assignedAgentId, {
            title: "📞 Клиент просит перезвонить",
            body: `${client.fullName}: ${request.topic}`,
            url: `/clients/${client.id}`,
          });
        }
        await prisma.callbackRequest.updateMany({
          where: { id: request.id, doneAt: null },
          data: { doneAt: new Date() },
        });
      }
      toNote += 1;
      continue;
    }

    if (phone) {
      console.log(`[заявка] ${when} · ${request.channel} · карточки нет · ${phone} · ${request.topic}`);
      if (APPLY) {
        await createLeadFromChannel({
          fullName: `Клиент ${request.channel}`,
          phone,
          source: toSource(request.channel),
          channel: request.channel,
          requirementsNotes: note,
        });
        await prisma.callbackRequest.updateMany({
          where: { id: request.id, doneAt: null },
          data: { doneAt: new Date() },
        });
      }
      toLead += 1;
      continue;
    }

    console.log(`[РУКАМИ] ${when} · ${request.channel} · ни телефона, ни карточки · ${request.topic}`);
    skipped += 1;
  }

  console.log(
    `\nИтог: заявок ${toLead}, пометок в карточку ${toNote}, требуют разбора руками ${skipped}.` +
      (APPLY ? "" : "\nЭто был пробный прогон — повторите с --apply.")
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Ответ клиента на просьбу подтвердить показ.
 *
 * Просьбу отправляет джоб (lib/meetingReminders.ts), а поймать ответ можно только
 * там, где проходит КАЖДОЕ входящее сообщение клиента из всех каналов сразу —
 * это lib/clientMessageAlert.ts (его дёргают и messengers/conversation.ts, и
 * telegram/bot.ts). Оттуда сюда и приходит вызов.
 *
 * Почему модуль отдельный, а не внутри meetingReminders: тот импортирует отправку
 * в мессенджер (conversationDelivery → messengers/conversation → clientMessageAlert),
 * и приём ответа в том же файле замкнул бы импорты в цикл, на который падает CI.
 * Здесь зависимости только на базу и push.
 *
 * ГЛАВНОЕ ПРАВИЛО, которое этот модуль обязан соблюдать: молчание клиента НЕ
 * является отказом. Отменять показ автоматически нельзя ни по тишине, ни даже по
 * прямому «не смогу» — CRM только ставит отметку и сигналит агенту, решение за
 * человеком.
 *
 * ОДНО СОБЫТИЕ — ОДИН PUSH. На «не смогу» срабатывает не только этот разбор: тем
 * же сообщением бот делает ход с action=cancel и снимает показ (showingBooking).
 * Агент получал два уведомления об одном отказе. Кто добежал первым, тот и
 * сообщает — общая отметка DECLINE_NOTIFIED_STAGE в Interaction.remindersSent.
 */

import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { DUSHANBE_OFFSET_MS } from "./dushanbeTime.js";
import { classifyShowingReply } from "./showingReply.js";
import { DECLINE_NOTIFIED_STAGE } from "./showingBooking.js";

/** Ступени подтверждения в Interaction.remindersSent — тот же механизм, что у
 *  напоминаний: одна запись = одно отправленное сообщение, повтор невозможен. */
export const CONFIRM_ASK_STAGE = "confirm-ask";
export const CONFIRM_NUDGE_STAGE = "confirm-nudge";

/** "HH:MM" по Душанбе. Дубль тут не нужен — берём общий сдвиг из dushanbeTime. */
function timeLabel(date: Date): string {
  const wall = new Date(date.getTime() + DUSHANBE_OFFSET_MS);
  return `${String(wall.getUTCHours()).padStart(2, "0")}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Засчитать входящее сообщение клиента как ответ на просьбу подтвердить показ.
 *
 * Никогда не бросает: входящее сообщение важнее любой нашей отметки на нём.
 */
export async function applyShowingReply(clientId: string, text: string, now: Date = new Date()): Promise<void> {
  try {
    // Пустой текст — фото или голосовое: подтверждением это считать нельзя,
    // расшифровка к этому моменту ещё не готова.
    if (!text.trim()) return;

    // Только показ, о котором мы УЖЕ спросили и на который ещё не получили ответа.
    // Без условия confirmAskedAt случайное «ок» в переписке за неделю до показа
    // засчиталось бы как подтверждение, которого человек не давал.
    const showing = await prisma.interaction.findFirst({
      where: {
        clientId,
        type: "SHOWING",
        completedAt: null,
        confirmAskedAt: { not: null, lte: now },
        confirmedAt: null,
        declinedAt: null,
        nextActionDate: { gte: now },
        // client: { deletedAt: null } (27.08.2026) — вызывается из
        // clientMessageAlert раньше, чем Telegram успевает отвязать диалог от
        // удалённой карточки: первое же сообщение человека после удаления
        // проходило сюда со старым clientId и подтверждало показ клиента,
        // которого в CRM уже нет — с обновлением записи и push агенту.
        client: { deletedAt: null },
      },
      orderBy: { nextActionDate: "asc" },
      select: {
        id: true,
        agentId: true,
        nextActionDate: true,
        remindersSent: true,
        client: { select: { fullName: true, phone: true, shortId: true } },
      },
    });
    if (!showing?.nextActionDate) return;

    const verdict = classifyShowingReply(text);
    const at = timeLabel(showing.nextActionDate);
    const url = `/clients/${showing.client.shortId}`;

    if (verdict === "no") {
      // Показ НЕ отменяем и время не стираем: «не смогу» часто означает «давайте
      // перенесём», и это разговор живого агента с живым человеком, а не действие
      // системы. Наша работа — чтобы агент узнал об этом до выезда.
      await prisma.interaction.update({
        where: { id: showing.id },
        data: {
          declinedAt: now,
          // Сразу гасим ступень «клиент молчит»: он не молчит, он ответил, и
          // второй push про того же клиента был бы шумом поверх плохой новости.
          ...(showing.remindersSent.includes(CONFIRM_NUDGE_STAGE) ? {} : { remindersSent: { push: CONFIRM_NUDGE_STAGE } }),
        },
      });
      // Тот же tag, что у назначения и отмены: в шторке живёт ОДНО уведомление про
      // этот показ. На «не смогу» следом почти всегда идёт ход бота с action=cancel,
      // и раньше агент получал два push об одном событии — «клиент не сможет
      // прийти» и «клиент отменил показ». Теперь второй путь молчит, увидев отметку
      // DECLINE_NOTIFIED_STAGE, а ставим её только после успешной доставки: не
      // дошло — пусть скажет отмена, это лучше молчания.
      if (!showing.agentId) return;
      const delivered = await sendPushToAgent(showing.agentId, {
        title: "❗ Клиент не сможет прийти на показ",
        body: `${showing.client.fullName} · ${showing.client.phone ?? "телефон не указан"} — показ в ${at}. Свяжитесь и договоритесь о новом времени.`,
        url,
        tag: `showing-${showing.id}`,
      });
      if (delivered > 0) {
        await prisma.interaction.update({
          where: { id: showing.id },
          data: { remindersSent: { push: DECLINE_NOTIFIED_STAGE } },
        });
      }
      return;
    }

    // "unclear" тоже засчитываем: человек прочитал напоминание и написал в ответ —
    // значит он на связи и в курсе. Требовать ровно слова «да» означало бы
    // объявить неподтверждённым клиента, который спросил «а во сколько?».
    await prisma.interaction.update({ where: { id: showing.id }, data: { confirmedAt: now } });
    if (!showing.agentId) return;
    await sendPushToAgent(showing.agentId, {
      title: verdict === "yes" ? "✅ Клиент подтвердил показ" : "✅ Клиент ответил на напоминание о показе",
      body:
        verdict === "yes"
          ? `${showing.client.fullName} — показ в ${at} в силе.`
          : `${showing.client.fullName} — ответил «${text.trim().slice(0, 60)}». Показ в ${at}, считаем в силе.`,
      url,
      tag: `showing-confirm-${showing.id}`,
    });
  } catch (err) {
    console.error("[showing] разбор ответа клиента:", err instanceof Error ? err.message : err);
  }
}

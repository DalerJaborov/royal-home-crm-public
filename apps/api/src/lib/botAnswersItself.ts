/**
 * «БОТ ОТВЕЧАЕТ САМ» — ОДНА ДВЕРЬ (владелец 18.11.2026: «бот никак не вызывал администратора, директора и так далее…
 * полностью сам все отвечает… и по возможности брал заявки. И в комментариях»).
 *
 * Настройка `Settings.botAnswersItself` (экран «Бот», по умолчанию ВЫКЛ) читается ТОЛЬКО здесь, а решение «звать ли
 * человека» по каждому виду сигнала — ТОЛЬКО в `staffSignalAllowed` ниже: одна таблица на ядро и старый путь, на
 * Instagram/Facebook/WhatsApp, сайт, Telegram и комментарии. Сторож в CI (tests/bot-answers-itself-guard.test.ts) не даёт
 * файлу клиентского бота звать людей пушем мимо этой двери.
 *
 * Что убирается при ВКЛ (клиент уже получил ответ бота или бот сам отвечает безопасной фразой и ведёт к номеру):
 *  - «бот передал / агент уточнит» руководству по чату БЕЗ карточки и без своего агента (follow_up, handover);
 *  - «комментарий требует человека» (модель решила escalate) — бот отвечает под постом сам;
 *  - «бот трижды счёл не по теме» — бот не снимается с диалога и никого не зовёт;
 *  - Telegram: «бот передал разговор человеку» по чату без карточки и без своего агента.
 * Что остаётся всегда (`staffSignalAllowed` = true при любом положении):
 *  - агенту — о сообщении ЕГО клиента (у чата есть действующий агент);
 *  - чат с карточкой без агента — назначающим (это уже заявка);
 *  - техсбой: бот НЕ ответил вовсе (ход сломался, ИИ недоступен, клиент без ответа 30 минут, ключ, бюджет), аварийный
 *    рубильник канала (CUSTOMER_AGENT_CHANNEL_OFF) — без этого клиент остался бы в тишине и никто бы не узнал.
 *    Где ВКЛ и клиент без ответа, «клиент ждёт» уходит не пушем руководству, а строкой журнала (`journalInstead`):
 *    директор узнаёт о новом виде поломки через «Здоровье системы», а не о каждом клиенте.
 */
import { prisma } from "../db.js";

/** Сбой чтения настроек — ВЫКЛ: прежнее поведение (человека зовут) безопаснее тишины. */
export async function loadBotAnswersItself(): Promise<boolean> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botAnswersItself: true } });
    return row?.botAnswersItself === true;
  } catch {
    return false;
  }
}

/**
 * Вид сигнала людям.
 *  - `answered_handover`: бот уже сказал клиенту «это скажет агент / передал сотруднику» (follow_up, handover, Telegram
 *    escalate/action/unreadable/core_refused) — убирается при ВКЛ;
 *  - `bot_choice`: бот сам решил позвать человека, клиенту ответ дан или будет дан ботом (escalate комментария, офтопик) —
 *    убирается при ВКЛ;
 *  - `unanswered`: клиент не получил от бота ничего (ход HELD без строки, молчание 30 минут) — при ВКЛ не пуш руководству,
 *    а журнал (`journalInstead`); агенту своего клиента и по карточке — как раньше;
 *  - `technical`: ход сломался, ИИ недоступен, аварийный рубильник канала, бот на канале выключен — всегда.
 */
export type StaffSignalKind = "answered_handover" | "bot_choice" | "unanswered" | "technical";

export interface StaffSignalContext {
  /** Настройка «Бот отвечает сам» (loadBotAnswersItself). */
  on: boolean;
  kind: StaffSignalKind;
  /** У чата есть действующий закреплённый агент: сигнал идёт ему о ЕГО клиенте. */
  ownAgent?: boolean;
  /** У чата есть карточка клиента (заявка уже есть). */
  hasCard?: boolean;
}

/** Чистая: сигнал людям уходит? Таблица — в шапке файла, тест — tests/bot-answers-itself.test.ts. */
export function staffSignalAllowed(ctx: StaffSignalContext): boolean {
  if (!ctx.on || ctx.kind === "technical") return true;
  if (ctx.ownAgent) return true;
  if (ctx.hasCard) return true;
  return false;
}

/** Чистая: при ВКЛ сигнал не ушёл, но молчать о клиенте без ответа нельзя — строка журнала вместо пуша. */
export function journalInstead(ctx: StaffSignalContext): boolean {
  return !staffSignalAllowed(ctx) && ctx.kind === "unanswered";
}

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
 *  - сбой бота: клиент НЕ получил ответа вовсе (ход сломался, модель передала без ответа, клиент без ответа 30 минут,
 *    ИИ недоступен, ключ, бюджет) и аварийный рубильник канала (CUSTOMER_AGENT_CHANNEL_OFF) — сигнал как раньше, один на
 *    эпизод разговора (ревью 1b, №1: «клиент 30 минут совсем без ответа — это сбой, админу сигнал»).
 */
import { prisma } from "../db.js";
import { looksLikeNoContactComplaint } from "../ai/complaintGuard.js";

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
 * Рубильник «номер из комментария — разговор» (Settings.botCommentPhoneConversation, по умолчанию ВЫКЛ; включается после «да» владельца на тексты): личное с вопросом,
 * публичный ответ, скрытие. Сбой чтения — ВЫКЛ: без «да» владельца клиентам не пишем.
 */
export async function loadCommentPhoneConversation(): Promise<boolean> {
  try {
    const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { botCommentPhoneConversation: true } });
    return row?.botCommentPhoneConversation === true;
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
 *  - `unanswered`: клиент не получил от бота ничего (ход HELD без строки, молчание 30 минут) — это сбой: сигнал всегда;
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
  /**
   * Номер клиента известен (WhatsApp, контакт, номер в переписке), а заявку этим ходом не оформили (ревью #283: «позвоните
   * мне завтра» → «позвоните нам сами», заявка потеряна). Номер есть — это заявка (решение владельца 13.11: лид = номер):
   * человек узнаёт, как раньше. Ядро Meta оформляет такую заявку само (lib/customerDmAgentTurn.ts) и сюда не доходит.
   */
  phoneKnown?: boolean;
}

/** Чистая: сигнал людям уходит? Таблица — в шапке файла, тест — tests/bot-answers-itself.test.ts. */
export function staffSignalAllowed(ctx: StaffSignalContext): boolean {
  if (!ctx.on || ctx.kind === "technical" || ctx.kind === "unanswered") return true;
  if (ctx.ownAgent) return true;
  if (ctx.hasCard) return true;
  if (ctx.phoneKnown) return true;
  return false;
}

/** Причина решения модели «позвать человека» говорит о жалобе (промпт комментариев: «жалуются на сотрудника»). */
const COMPLAINT_REASON = /жалоб|жалу[ею]|недовол|претензи|complain/iu;

/**
 * Чистая: комментарий, который человек должен увидеть при ЛЮБОМ положении «Бот отвечает сам» — жалоба на сотрудника или
 * агентство («агент не перезвонил», «никто не звонит»). Решение владельца 19.11 (docs/bot-operator/SPEC.md, случай 26):
 * жалобу видит руководитель; бот сам на неё не отвечает (ревью #283, блокер 3: иначе жалоба пропадала под постом).
 */
export function commentNeedsPerson(input: { text: string; reason?: string | null }): boolean {
  return looksLikeNoContactComplaint(input.text ?? "") || COMPLAINT_REASON.test(input.reason ?? "");
}

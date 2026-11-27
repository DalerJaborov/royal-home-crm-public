import { z } from "zod";
import { prisma } from "../../../db.js";
import { GROUP_QUIET_MS } from "../../../telegram/assistantGroupParticipation.js";
import type { AssistantActor } from "../actor.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * set_group_quiet — «ПОМОЛЧИ» СЛОВАМИ МОДЕЛИ В ОБЩЕЙ ГРУППЕ (17.11.2026, аудит Шабнам).
 *
 * Было: просьбу замолчать понимала только регулярка (telegram/assistantGroupParticipation.ts::
 * requestedGroupParticipation), и только если ВСЁ сообщение равно «помолчи» / «стоп» / «хомӯш бош».
 * «Хватит писать сюда на сегодня» уходило в модель, у которой не было инструмента: она отвечала
 * «хорошо, молчу», а автоответы по объектам в группе продолжались.
 * Теперь минуты и направление решает модель аргументом, а код пишет в то же поле, что регулярка и
 * команды /assistant_quiet и /assistant_resume (AssistantTelegramGroup.proactiveMutedUntil — одна дверь
 * для автоответов, реакций, приветствий и фоновых ответов). Регулярка остаётся быстрым путём без модели.
 *
 * Уровень A сознательно: запись безопасная и сама истекает (не больше MAX_QUIET_MINUTES), прямые обращения
 * к помощнице по-прежнему работают, а «подтвердить» в группе нечем — так же, как у регулярки. Инструмент
 * объявляется только на прямое обращение в группе (actor.groupChat): не на пересылку и не на автоответ,
 * где «помолчи» могло бы оказаться чужим текстом.
 */
export const DEFAULT_QUIET_MINUTES = GROUP_QUIET_MS / 60_000;
export const MAX_QUIET_MINUTES = 8 * 60;

const argsSchema = z.object({
  // Модель иногда шлёт число строкой.
  // null и пустая строка — «срок не назван» (по умолчанию), а не 0 (снять тишину).
  minutes: z.preprocess(value => (value === null || (typeof value === "string" && value.trim() === "") ? undefined : value),
    z.coerce.number().int().min(0).max(MAX_QUIET_MINUTES).optional()),
});

const inDirectGroupTurn = (actor: AssistantActor) => actor.surface === "telegram-group" && Boolean(actor.groupChat);

export const groupQuietPlugin: AssistantReadToolPlugin = {
  name: "set_group_quiet",
  level: "A",
  description:
    "Попросить помощницу ЗАМОЛЧАТЬ в этой общей группе (или снова отвечать): перестают приходить автоответы по номерам объектов, " +
    "реакции и приветствия; на прямые обращения («Шабнам, …») она по-прежнему отвечает. " +
    "Звать, когда человек просит замолчать любыми словами: «помолчи», «хватит писать», «не пиши сюда», «до вечера не отвечай», " +
    "«тихо на час», «хомӯш бош», «ҷавоб надеҳ», «гап назан»; и когда просит снова отвечать: «можешь писать», «продолжай» — тогда minutes = 0. " +
    `Время бери из слов («на час» = 60, «до вечера» ≈ оставшиеся часы), без срока — ${DEFAULT_QUIET_MINUTES}. ` +
    "НЕ звать для «молчи об этом клиенте», «не говори цену» и других просьб не про сам канал. " +
    "Без вызова этого инструмента НЕ обещай «молчу», «больше не пишу»: ничего не изменится. После вызова скажи одной короткой фразой, до какого времени.",
  parameters: {
    type: "object",
    properties: {
      minutes: {
        type: "integer",
        description: `На сколько минут замолчать (1–${MAX_QUIET_MINUTES}); 0 — снова отвечать самой. Без значения — ${DEFAULT_QUIET_MINUTES}.`,
      },
    },
  },
  statusPhrase: "Меняю режим группы…",
  // Меняет общий режим группы — запись: режиму просмотра (акционер) закрыто, в ходе «только прочитать» нет (ревью #506).
  sideEffect: "shared",
  allowed: inDirectGroupTurn,
  async run(raw, ctx) {
    const group = ctx.actor.groupChat;
    if (!inDirectGroupTurn(ctx.actor) || !group) return { error: "Режим тишины меняется только в общей группе, прямым обращением" };
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) return { error: `minutes — целое число минут от 0 до ${MAX_QUIET_MINUTES}` };
    const minutes = parsed.data.minutes ?? DEFAULT_QUIET_MINUTES;
    const until = minutes === 0 ? null : new Date(Date.now() + minutes * 60_000);
    // Та же сверка, что у регулярки: группа должна быть той же регистрации, а не заново подключённой.
    const update = await prisma.assistantTelegramGroup.updateMany({
      where: { chatId: group.chatId, createdAt: new Date(group.registeredAt) },
      data: { proactiveMutedUntil: until },
    });
    if (update.count !== 1) return { error: "Группа сейчас не подключена к помощнице" };
    return until
      ? { quiet: true, minutes, until: until.toISOString(), message: `Молчу ${minutes} мин: отвечаю только на прямые обращения` }
      : { quiet: false, message: "Снова отвечаю сама на ясные вопросы по объектам" };
  },
};

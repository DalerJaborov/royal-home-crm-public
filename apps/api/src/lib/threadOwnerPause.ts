import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { findScopedBotConversation } from "./customerConversationScope.js";
import { applyDeliveryPause, staffRelayPauseMs, OPERATOR_ECHO_PAUSE_MS } from "./deliveryPause.js";

/**
 * «ПЕРЕПИСКУ ВЕДЁТ ДРУГОЕ ПРИЛОЖЕНИЕ» (ревью #344, третий круг). Meta отвечает на отправку
 * 10/2018300 «another app controls the conversation» или 100/2534037 «your app is not the
 * thread owner» (Common Error Codes, developers.facebook.com/docs/messenger-platform/error-codes):
 * сотрудник забрал переписку во «Входящих» Business Suite или её ведёт другой бот. Повторять
 * личным ключом нельзя — клиент получил бы второй голос. Бот в этой переписке молчит так же,
 * как после ответа сотрудника руками (эстафетная пауза режима «только заявки», иначе 12 часов).
 *
 * Никогда не бросает: отказ отправки уже идёт своим путём, пауза — сверх него.
 */
export async function pauseBotForOtherThreadOwner(input: {
  accountId: string | null | undefined;
  peer: string | null | undefined;
  code: number | null;
  subcode: number | null;
}): Promise<{ paused: boolean }> {
  try {
    if (!input.accountId || !input.peer) return { paused: false };
    const account = await prisma.messengerAccount.findUnique({ where: { id: input.accountId }, select: { channel: true, externalId: true, title: true } });
    if (!account) return { paused: false };
    const conv = await findScopedBotConversation({ channel: account.channel, subscriberId: input.peer, accountExternalId: account.externalId })
      .catch(() => null);
    if (!conv) return { paused: false };
    const pauseMs = (await staffRelayPauseMs({ kind: "bot", id: conv.id })) ?? OPERATOR_ECHO_PAUSE_MS;
    await applyDeliveryPause({ kind: "bot", id: conv.id }, new Date(Date.now() + pauseMs), true);
    void logSystemError(
      "meta",
      `«${account.title}»: переписку ведёт другое приложение (код ${input.code ?? "—"}/${input.subcode ?? "-"}) — ` +
        `сотрудник во «Входящих» Meta или другой бот. Бот в этой переписке на паузе, ответ не повторялся (диалог ${conv.id}).`,
      { dedupKey: `thread-owner:${conv.id}`, dedupWindowMs: 6 * 60 * 60_000, silent: true }
    );
    return { paused: true };
  } catch (err) {
    console.error("[threadOwnerPause] пауза не поставлена:", err instanceof Error ? err.message : String(err));
    return { paused: false };
  }
}

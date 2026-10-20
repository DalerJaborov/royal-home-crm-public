import { enqueueDirectorAlert } from "./directorAlertQueue.js";

/**
 * Тревога о заблокированном голосовом — руководству. Тот же класс события,
 * что «вход с нового устройства» (loginLog.ts) и «разбор недели готов»
 * (problemReport.ts): роль DIRECTOR/ADMIN — владелец попросил именно
 * администратора и директора, не всех с каким-то правом.
 *
 * 07.09.2026 (часы алармов): раньше пуш уходил мгновенно, в любой час. Само
 * блокирование голосового происходит сразу (агент уже увидел отказ и
 * предупреждение в переписке, см. conversationDelivery.ts) — это
 * ДОПОЛНИТЕЛЬНЫЙ канал руководству, и он может подождать часов алармов без
 * вреда: событие уже остановлено, откладывается только уведомление о нём.
 */
export async function alertVoiceViolation(params: {
  agentName: string;
  clientName: string | null;
  clientId: string | null;
  reason: string;
  transcriptExcerpt: string;
}): Promise<void> {
  const who = params.clientName ?? "клиенту";
  const url = params.clientId ? `/clients/${params.clientId}` : "/messages";
  await enqueueDirectorAlert({
    title: "⛔ Голосовое заблокировано автоматикой",
    body: `${params.agentName} → ${who}: ${params.reason}. «${params.transcriptExcerpt.slice(0, 120)}»`,
    url,
    tag: "voice-compliance",
    recipientRoles: ["DIRECTOR", "ADMIN"],
  });
}

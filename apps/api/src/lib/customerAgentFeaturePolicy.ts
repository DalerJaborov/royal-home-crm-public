import type { CustomerAgentSayMode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { leadOnlyAppliesTo } from "../ai/leadOnlyMode.js";

/** Grounded free-phrase channel mode. Anything but the exact word `live` is `shadow`: the phrase is validated and counted, never sent.
 * Going live is an explicit deploy-time decision (CUSTOMER_AGENT_SAY_MODE=live) taken after the shadow statistics are read; it is deliberately
 * not a Settings column (that would need a schema migration) and not something a customer or the model can influence. */
export function customerAgentSayMode(env: Readonly<Record<string, string | undefined>> = process.env): CustomerAgentSayMode {
  return env.CUSTOMER_AGENT_SAY_MODE === "live" ? "live" : "shadow";
}

/** Existing feature switches restrict implemented customer capabilities; a
 * legacy switch never grants a new tool, transport, identity or staff right.
 * `channel` is REQUIRED (second review 13.11.2026, №8): the lead-only mode depends on it, and an omitted channel used
 * to mean "mode off" silently. A caller that genuinely has no messenger channel passes `null` and says why. */
export async function loadCustomerAgentFeaturePolicy(channel: string | null) {
  const row = await prisma.settings.findUnique({ where: { id: "singleton" }, select: {
    botCanSendLinks: true, botCanSendPhotos: true, botPhotosPerOffer: true, botCanBookShowings: true, botCanHandleVacancies: true,
    botCanRequestCallback: true, botCanAskOwner: true, botLeadOnlyMode: true,
  } });
  // Режим «только заявки» (13.11.2026): ссылок и фото нет при любых прочих тумблерах, но ТОЛЬКО в
  // WhatsApp/Instagram/Facebook: чат сайта и вызовы без канала остаются прежними (решение 13.11 после ревью).
  // Подборку убирает из инструментов customerDmAgentTurn по тому же правилу.
  const leadOnly = row?.botLeadOnlyMode === true && leadOnlyAppliesTo(channel);
  return { leadOnly, links: !leadOnly && row?.botCanSendLinks === true, photos: !leadOnly && row?.botCanSendPhotos === true,
    photosPerOffer: Math.max(0, Math.min(5, row?.botPhotosPerOffer ?? 0)),
    showings: row?.botCanBookShowings === true, vacancies: row?.botCanHandleVacancies === true,
    // Тумблеры экрана «Бот» (31.10.2026): выключенный — инструмент не предлагается
    // модели на этом ходе. Каталог инструментов в toolSchemaHash ревизии не меняется.
    callbacks: row?.botCanRequestCallback === true, ownerQuestions: row?.botCanAskOwner === true };
}

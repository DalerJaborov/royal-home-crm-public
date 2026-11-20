import type { NarrationReleaseView } from "@royal-home/shared";
import { prisma } from "../db.js";
import { narrationRemixPending } from "./narrationAutoFlow.js";
import { releaseChannelsView } from "./remakeOldPosts.js";
import { isHandoffPublishRunning } from "./videoHandoff.js";

/**
 * ХОД ВЫПУСКА НОВОЙ ОЗВУЧКИ (18.11.2026) для блока карточки: CRM накладывает голос → ждёт своего времени →
 * уходит в сети → вышло (по сетям: новый пост, старый снят / удалите сами). null — показывать нечего.
 *
 * «Накладывает» (MIXING) — только когда обход перемикса правда возьмёт объект (narrationRemixPending, 20.11.2026).
 * Прежнее правило «ролик вышел, а наложенной CRM версии нет» горело и там, где CRM ничего накладывать не будет:
 * голос вклеил монтажёр по передаче, своя музыка не включена для этой версии, отправка не LIVE. Объект №209 висел
 * с полосой «обычно пару минут» больше суток.
 */
export async function narrationReleaseView(p: { id: string; videoMasterNarrationVersionId: string | null; scheduledPublishAt: Date | null; scheduledPublishReason: string | null },
  latest: { id: string; status: string; approvedAt: Date | null } | undefined): Promise<NarrationReleaseView | null> {
  if (!latest || latest.status !== "READY" || !latest.approvedAt) return null;
  // Заявка этой версии (третье ревью 18.11): переиспользованная заявка старше утверждения, поэтому по ссылке на версию;
  // старые заявки без ссылки — по времени, как раньше.
  const request = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: p.id, replaceOldPostsOnPublish: true,
    OR: [{ narrationVersionId: latest.id }, { narrationVersionId: null, reason: "NARRATION_CHANGED", createdAt: { gte: latest.approvedAt } }] },
    orderBy: { createdAt: "desc" }, select: { oldPosts: true, oldPostsOutcome: true, oldPostsReplacedAt: true } });
  const channels = releaseChannelsView(request?.oldPostsOutcome ?? null);
  const base = { versionId: latest.id, at: p.scheduledPublishAt?.toISOString() ?? null, reason: p.scheduledPublishReason, channels };
  if (p.videoMasterNarrationVersionId !== latest.id) {
    // Ещё не наложена: «накладывает» — только если обход перемикса возьмёт объект (то же решение remixWanted).
    if (!request && await narrationRemixPending(p.id)) return { ...base, stage: "MIXING", at: null, reason: null };
    return null;
  }
  if (!request) return null;
  if (request.oldPostsReplacedAt) return { ...base, stage: "DONE", at: null };
  if (request.oldPosts !== null || await isHandoffPublishRunning(p.id)) return { ...base, stage: "PUBLISHING" };
  return { ...base, stage: "SCHEDULED" };
}

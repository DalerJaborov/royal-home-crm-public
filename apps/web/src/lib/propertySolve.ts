import type { Property } from "../types";

/**
 * «Решить сейчас» в просмотре карточки объекта: когда в блоке есть что показать
 * (24.09.2026).
 *
 * Блок собирается из шести частей, и каждая сама решает, рисоваться ли ей. У
 * агента на обычном объекте в продаже не рисовалась ни одна: оставались
 * заголовок и служебная подпись «Кнопка есть только у того, у кого есть право».
 * Условия частей живут здесь, их зовут и сами части, и карточка: когда меняется
 * правило части, пустой блок не возвращается.
 */
type P = Pick<
  Property,
  "status" | "pipeline" | "reviewRejectionReason" | "siteUrl" | "videoHandoffFinalPath" | "publishedChannels"
>;

/** Подсказки «объект готовится» и «материалы возвращены» (PipelineHints). */
export function pipelineHintsVisible(p: P): boolean {
  return (
    !!p.pipeline?.inPipeline ||
    ((p.status === "AWAITING_PHOTOS" || p.status === "AWAITING_VIDEO") && !!p.reviewRejectionReason)
  );
}

/** «Одобрить / вернуть» фото и видео (MaterialsModerationCard). */
export function moderationVisible(p: P, canModerate: boolean): boolean {
  return p.status === "PENDING_REVIEW" && canModerate;
}

/** Строка «Сайт royalhome.tj» (SitePublishToggle). */
export function sitePublishVisible(p: P, canPublish: boolean): boolean {
  return canPublish || !!p.siteUrl;
}

/** Ручная публикация в TikTok (TikTokPublishButton) — маркетинг и руководство. */
export function tiktokVisible(p: P, opts: { marketingRole: boolean; tiktokConnected: boolean; isTrashed: boolean }): boolean {
  return !opts.isTrashed && opts.marketingRole && !!p.videoHandoffFinalPath && opts.tiktokConnected;
}

export function solveHasContent(
  p: P,
  opts: {
    canModerate: boolean;
    canPublish: boolean;
    canEdit: boolean;
    isTrashed: boolean;
    isDealDriven: boolean;
    marketingRole: boolean;
    tiktokConnected: boolean;
  },
): boolean {
  return (
    pipelineHintsVisible(p) ||
    moderationVisible(p, opts.canModerate) ||
    sitePublishVisible(p, opts.canPublish) ||
    (opts.canEdit && !opts.isTrashed && p.status === "EDITING") ||
    tiktokVisible(p, opts) ||
    opts.isDealDriven
  );
}

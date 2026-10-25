import type { ReelsAutoBoostStatus } from "@royal-home/shared";

/**
 * РЕШЕНИЯ АВТОПРОДВИЖЕНИЯ РОЛИКОВ — чистая функция, без базы, сети и часов.
 *
 * Вход — факты об объектах с опубликованным в Instagram роликом и журнал уже
 * принятых решений (ReelAutoBoostAd); выход — список действий. Исполнитель
 * (reelsAutoBoost.ts) только применяет их. Вся логика «что продвигать, а что
 * ставить на паузу» лежит здесь и покрыта тестами по каждому правилу и границе.
 *
 * ПРАВИЛА
 *  создать  — ролик в Instagram, объект AVAILABLE, виден на сайте (publishedOnSite,
 *             не offSite, не в корзине), с момента публикации прошло не больше
 *             maxAgeDays, записи об этом ролике ещё нет (один media id — одно
 *             объявление, даже если прежнее поставили на паузу);
 *  пауза    — объект стал SOLD/RESERVED/снят/ушёл с сайта/в корзину; ролик старше
 *             maxAgeDays; стоп-лосс (потратил ≥ порога и ни одной переписки);
 *             вышли за maxActive (первыми уходят самые старые);
 *  оставить — всё остальное, что уже продвигается.
 * Из активных и кандидатов на создание составляется один список «сначала свежие»,
 * в лимит maxActive входят первые: новый ролик вытесняет самый старый, а не стоит
 * в очереди за ним.
 *
 * ПРОБНЫЙ РЕЖИМ (dryRun). Объявлений в Meta нет, поэтому «активными» считаются
 * записи PLANNED — это то, что CRM создала бы. В боевом режиме PLANNED — ролик,
 * которому объявление ещё НЕ создано: он участвует в отборе наравне с новыми
 * кандидатами (и паузится, если успел стать непригодным).
 */

/** Факт об опубликованном ролике и его объекте. */
export interface ReelFact {
  propertyId: string;
  /** Идентификатор публикации в Instagram (Property.publishedPostIds.INSTAGRAM). */
  mediaId: string;
  /**
   * Когда ролик вышел (publishedPostIds.RAW_VIDEO_PUBLISHED_AT). null — дата
   * неизвестна: нового объявления не создаём (честное «нет данных»), а уже
   * созданное считает возраст от создания записи.
   */
  publishedAt: Date | null;
  status: string;
  deleted: boolean;
  offSite: boolean;
  publishedOnSite: boolean;
}

/** Запись журнала (ReelAutoBoostAd) в объёме, нужном решению. */
export interface ReelRecord {
  propertyId: string;
  mediaId: string;
  status: ReelsAutoBoostStatus;
  createdAt: Date;
  /** Когда запись менялась в последний раз — для паузы между повторами FAILED. */
  updatedAt: Date;
  attempts: number;
  spendUsd: number | null;
  conversations: number | null;
}

export interface ReelsAutoBoostRules {
  dryRun: boolean;
  maxActive: number;
  maxAgeDays: number;
  stopLossSpendUsd: number;
}

export type ReelsAutoBoostAction =
  | { kind: "create"; propertyId: string; mediaId: string; reason: string }
  | { kind: "pause"; propertyId: string; mediaId: string; reason: string }
  | { kind: "keep"; propertyId: string; mediaId: string; reason: string };

/** Повтор неудавшегося создания: не чаще раза в 6 часов и не больше трёх попыток. */
export const FAILED_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
export const FAILED_MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

const STATUS_RU: Record<string, string> = {
  SOLD: "продан",
  RESERVED: "в резерве",
  WITHDRAWN: "снят с продажи",
};

/** Почему ролик НЕ годится для продвижения (null — годится). Одно правило для создания и паузы. */
export function unfitReason(fact: ReelFact): string | null {
  if (fact.deleted) return "объект в корзине";
  if (fact.status !== "AVAILABLE") return `объект ${STATUS_RU[fact.status] ?? "больше не в продаже"}`;
  if (fact.offSite) return "объект закрытый (только для своих)";
  if (!fact.publishedOnSite) return "объект снят с сайта";
  return null;
}

function ageDays(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / DAY_MS;
}

function fmtAge(days: number): string {
  return String(Math.floor(days * 10) / 10).replace(".", ",");
}

export function decideReelsAutoBoost(
  state: { facts: ReelFact[]; records: ReelRecord[] },
  now: Date,
  rules: ReelsAutoBoostRules
): ReelsAutoBoostAction[] {
  const { dryRun, maxActive, maxAgeDays, stopLossSpendUsd } = rules;
  const factByMedia = new Map(state.facts.map((f) => [f.mediaId, f]));
  const recordByMedia = new Map(state.records.map((r) => [r.mediaId, r]));
  const actions: ReelsAutoBoostAction[] = [];

  /** Пул отбора: кто претендует на место среди maxActive, и когда вышел ролик. */
  const pool: Array<{ propertyId: string; mediaId: string; at: number; isNew: boolean; reason: string }> = [];

  // 1. Уже принятые решения: оставить или поставить на паузу.
  for (const rec of state.records) {
    // «Живые» записи: ACTIVE всегда; PLANNED — в пробном режиме это «как будто активно»,
    // в боевом это ролик, которому объявление ещё не создано (он идёт в пул как новый).
    const live = rec.status === "ACTIVE" || rec.status === "PLANNED";
    if (!live) continue;
    const pendingCreate = rec.status === "PLANNED" && !dryRun;
    const fact = factByMedia.get(rec.mediaId);
    const publishedAt = fact?.publishedAt ?? rec.createdAt;

    let pauseReason: string | null = null;
    if (!fact) {
      pauseReason = "объект удалён или ролик снят с Instagram";
    } else {
      pauseReason = unfitReason(fact);
      if (!pauseReason && ageDays(publishedAt, now) > maxAgeDays) {
        pauseReason = `ролику ${fmtAge(ageDays(publishedAt, now))} дн. — старше ${maxAgeDays} дн., продвижение закончено`;
      }
      if (
        !pauseReason &&
        rec.status === "ACTIVE" &&
        rec.spendUsd !== null &&
        stopLossSpendUsd > 0 &&
        rec.spendUsd >= stopLossSpendUsd &&
        (rec.conversations ?? 0) === 0
      ) {
        pauseReason = `стоп-лосс: потрачено ${rec.spendUsd.toFixed(2)} при пороге ${stopLossSpendUsd.toFixed(2)}, переписок нет`;
      }
    }
    if (pauseReason) {
      actions.push({ kind: "pause", propertyId: rec.propertyId, mediaId: rec.mediaId, reason: pauseReason });
      continue;
    }
    pool.push({
      propertyId: rec.propertyId,
      mediaId: rec.mediaId,
      at: publishedAt.getTime(),
      isNew: pendingCreate,
      reason: pendingCreate ? "ролик подходит, объявление ещё не создано" : "ролик подходит, продвигается",
    });
  }

  // 2. Новые кандидаты: ролика нет в журнале вообще (или прошлая попытка создания провалилась давно).
  for (const fact of state.facts) {
    const rec = recordByMedia.get(fact.mediaId);
    if (rec) {
      const retry =
        rec.status === "FAILED" &&
        rec.attempts < FAILED_MAX_ATTEMPTS &&
        now.getTime() - rec.updatedAt.getTime() >= FAILED_RETRY_AFTER_MS;
      if (!retry) continue;
    }
    if (unfitReason(fact)) continue;
    if (!fact.publishedAt) continue; // дата публикации неизвестна — не гадаем
    if (ageDays(fact.publishedAt, now) > maxAgeDays) continue;
    pool.push({
      propertyId: fact.propertyId,
      mediaId: fact.mediaId,
      at: fact.publishedAt.getTime(),
      isNew: true,
      reason: `новый ролик, вышел ${fmtAge(ageDays(fact.publishedAt, now))} дн. назад`,
    });
  }

  // 3. Сначала свежие; в лимит входят первые maxActive.
  pool.sort((a, b) => b.at - a.at || a.mediaId.localeCompare(b.mediaId));
  pool.forEach((p, i) => {
    if (i < maxActive) {
      actions.push({ kind: p.isNew ? "create" : "keep", propertyId: p.propertyId, mediaId: p.mediaId, reason: p.reason });
    } else if (!p.isNew) {
      actions.push({
        kind: "pause",
        propertyId: p.propertyId,
        mediaId: p.mediaId,
        reason: `вышли за лимит ${maxActive} одновременных роликов — это один из самых старых`,
      });
    }
    // Новый ролик за пределом лимита не создаём и не записываем: он слишком старый для
    // текущей очереди и, пока моложе maxAgeDays, будет рассмотрен на следующем проходе.
  });

  return actions;
}

/**
 * РАЗОВОЕ (и повторяемое) ОБНОВЛЕНИЕ КОНЦОВКИ ПОДПИСЕЙ — владелец 25.09.2026:
 * «всем агентам, и будущим, и прошлым; объекты, которые ещё не вышли и уже
 * вышли — обнови всем подписи через наш механизм».
 *
 * Вышедшие объекты идут через тот же refreshPublishedCaptions, что и кнопка
 * «Обновить подписи» (сохранённая подпись + концовка с агентом → Facebook,
 * Telegram, YouTube; Instagram и TikTok правке через API не поддаются —
 * возвращаются шагами руками). Невышедшим меняется только текст в карточке —
 * при публикации он уйдёт уже новым.
 *
 * На проде tsx нет (контейнер крутит dist), поэтому это модуль, а не скрипт:
 *   docker exec royalhome-crm-api-1 node --input-type=module -e \
 *     "const m = await import('/repo/apps/api/dist/lib/captionContactBackfill.js'); \
 *      console.log(JSON.stringify(await m.refreshAllCaptionContactFooters({ apply: false }), null, 1)); process.exit(0)"
 * Без apply ничего не пишет и никуда не ходит. Повторный прогон безопасен:
 * applyContactFooter узнаёт свою концовку и заменяет её, а не копит.
 */
import { prisma } from "../db.js";
import { applyContactFooter } from "./reelsCaptionTemplate.js";
import { refreshPublishedCaptions } from "./publishedVideoFix.js";

const AGENT_SELECT = { select: { fullName: true, phone: true } } as const;

export interface CaptionBackfillRow {
  shortId: number;
  agent: string | null;
  published: string[];
  changed: boolean;
  updated?: string[];
  failed?: { channel: string; error: string }[];
  manual?: unknown;
}

export async function refreshAllCaptionContactFooters(opts: { apply: boolean }): Promise<CaptionBackfillRow[]> {
  const properties = await prisma.property.findMany({
    where: { deletedAt: null, reelsCaption: { not: null } },
    select: {
      id: true,
      shortId: true,
      reelsCaption: true,
      publishedChannels: true,
      intakeAgent: AGENT_SELECT,
      assignedAgent: AGENT_SELECT,
      createdBy: AGENT_SELECT,
    },
    orderBy: { shortId: "asc" },
    take: 1000,
  });

  const report: CaptionBackfillRow[] = [];
  // По одному, а не пачкой: каждый вышедший объект — до трёх вызовов внешних
  // API (Meta, Telegram, Google), и лимиты у них на частоту, а не на объём.
  for (const p of properties) {
    const agent = p.intakeAgent ?? p.assignedAgent ?? p.createdBy ?? null;
    const next = applyContactFooter(p.reelsCaption!, agent);
    const published = p.publishedChannels ?? [];
    const row: CaptionBackfillRow = { shortId: p.shortId, agent: agent?.fullName ?? null, published, changed: next !== p.reelsCaption };

    if (opts.apply) {
      if (published.length > 0) {
        const result = await refreshPublishedCaptions(p.id, { keepStoredCaption: true });
        row.updated = result.updated;
        row.failed = result.failed;
        row.manual = result.manual;
      } else if (row.changed) {
        await prisma.property.update({ where: { id: p.id }, data: { reelsCaption: next } });
      }
    }
    report.push(row);
  }
  return report;
}

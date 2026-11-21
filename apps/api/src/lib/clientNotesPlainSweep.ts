/**
 * СВЕРКА «ЗАМЕТОК БЕЗ ЯРЛЫКОВ» (22.11.2026, PR #382).
 *
 * Client.requirementsNotesPlain пишет перехват записи в db.ts. Этот обход сверяет ВСЕ
 * карточки с заметками и чинит копию там, где она разошлась с тем, что даёт
 * clientNotesPlain() сейчас: строки до этой правки, смена списка ярлыков
 * (CLIENT_NOTE_LABELS_REV), запись мимо перехвата (сырой SQL, откат правки, вложенная
 * запись). Только по версии искать нельзя: копия, испорченная при текущей версии, не
 * нашлась бы никогда (ревью #382).
 *
 * Когда: при старте worker (после каждого выката) и раз в ночь (cron.ts,
 * client-notes-plain-sweep). Порциями по BATCH; пишет только расходящиеся строки и
 * только две служебные колонки.
 *
 * Гонка с живой записью: UPDATE сверяет requirementsNotes с прочитанным — если
 * карточку успели поправить, её копию уже записал перехват, и обход её не трогает.
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { CLIENT_NOTE_LABELS_REV, clientNotesPlain } from "./clientNoteLabels.js";

const BATCH = 500;

/** Возвращает, сколько карточек пришлось исправить. */
export async function sweepClientNotesPlain(maxRows = 500_000): Promise<number> {
  let fixed = 0;
  let seen = 0;
  let afterId = "";
  while (seen < maxRows) {
    const rows = await prisma.$queryRaw<Array<{ id: string; notes: string | null; plain: string | null; rev: number | null }>>(Prisma.sql`
      SELECT id, "requirementsNotes" AS notes, "requirementsNotesPlain" AS plain, "requirementsNotesPlainRev" AS rev
      FROM "Client"
      WHERE id > ${afterId}
      ORDER BY id
      LIMIT ${BATCH}
    `);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    seen += rows.length;
    const stale = rows
      .map((r) => ({ ...r, want: r.notes ? clientNotesPlain(r.notes) || null : null }))
      .filter((r) => r.plain !== r.want || r.rev !== CLIENT_NOTE_LABELS_REV);
    if (stale.length === 0) continue;
    // Одним запросом на порцию; сверка notes — защита от гонки с живой записью (см. шапку).
    const n = await prisma.$executeRaw(Prisma.sql`
      UPDATE "Client" AS c
      SET "requirementsNotesPlain" = v.plain, "requirementsNotesPlainRev" = ${CLIENT_NOTE_LABELS_REV}
      FROM unnest(${stale.map((r) => r.id)}::text[], ${stale.map((r) => r.notes)}::text[], ${stale.map((r) => r.want)}::text[])
        AS v(id, notes, plain)
      WHERE c.id = v.id AND c."requirementsNotes" IS NOT DISTINCT FROM v.notes
    `);
    fixed += n;
  }
  return fixed;
}

/**
 * ДОСЧЁТ «ЗАМЕТОК БЕЗ ЯРЛЫКОВ» (22.11.2026, PR #382).
 *
 * Client.requirementsNotesPlain пишет перехват записи в db.ts — но только для новых
 * записей. Строки, сохранённые до этой правки, и строки, посчитанные по прежней версии
 * списка ярлыков (CLIENT_NOTE_LABELS_REV сменился), досчитывает этот обход: при старте
 * worker, то есть после каждого выката. Порциями по BATCH, без блокировки карточек
 * дольше одного UPDATE; ничего, кроме двух служебных колонок, не трогает.
 *
 * Гонка с живой записью: UPDATE сверяет requirementsNotes с прочитанным — если
 * карточку успели поправить, её колонку уже записал перехват, и обход её не трогает.
 */
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { CLIENT_NOTE_LABELS_REV, clientNotesPlain } from "./clientNoteLabels.js";

const BATCH = 500;

export async function sweepClientNotesPlain(maxRows = 200_000): Promise<number> {
  let done = 0;
  let afterId = "";
  while (done < maxRows) {
    const rows = await prisma.$queryRaw<Array<{ id: string; notes: string | null }>>(Prisma.sql`
      SELECT id, "requirementsNotes" AS notes FROM "Client"
      WHERE id > ${afterId}
        AND "requirementsNotesPlainRev" IS DISTINCT FROM ${CLIENT_NOTE_LABELS_REV}
      ORDER BY id
      LIMIT ${BATCH}
    `);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    const ids = rows.map((r) => r.id);
    const notes = rows.map((r) => r.notes);
    const plains = rows.map((r) => (r.notes ? clientNotesPlain(r.notes) || null : null));
    // Одним запросом на порцию; сверка notes — защита от гонки с живой записью (см. шапку).
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "Client" AS c
      SET "requirementsNotesPlain" = v.plain, "requirementsNotesPlainRev" = ${CLIENT_NOTE_LABELS_REV}
      FROM unnest(${ids}::text[], ${notes}::text[], ${plains}::text[]) AS v(id, notes, plain)
      WHERE c.id = v.id AND c."requirementsNotes" IS NOT DISTINCT FROM v.notes
    `);
    done += rows.length;
  }
  return done;
}

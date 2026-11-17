import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { raiseCriticalAlarm } from "./channelKeyAlarm.js";

/**
 * СТОРОЖ СВЕЖЕСТИ КОПИЙ (14.11.2026, охота на «внезапно и молча», №4).
 *
 * `ops/backup.sh` работает вне CRM и лишь присылает отчёт (`POST /backups/report`
 * -> строка `BackupRun`); раньше дальше строки на экране `/backups` дело не шло:
 * ни при неудачном прогоне, ни при полном молчании (таймер отключили, скрипт
 * завис, ключ отчёта пропал) никто не узнавал, пока копия не понадобилась.
 *
 * Тревога директору (дверь `raiseCriticalAlarm`, мимо часов алармов) в двух случаях:
 *  1. последняя УДАЧНАЯ выгрузка наружу (OFFSITE) старше 26 часов или её нет вовсе;
 *  2. последний прогон какого-то вида (DB, UPLOADS, RESTORE_DRILL...) за 26 часов
 *     провалился и позже успеха того же вида не было.
 * Метка `backup:<вид>`, повтор не чаще 12 часов (дверь).
 */
export const BACKUP_STALE_MS = 26 * 60 * 60_000;

const KIND_LABEL: Record<string, string> = {
  DB: "базы данных",
  UPLOADS: "файлов",
  PRIVATE_UPLOADS: "закрытых файлов",
  PROPERTY_VIDEO: "видео объектов",
  DEAL_DOCS: "документов сделок",
  OFFSITE: "выгрузки наружу",
  RESTORE_DRILL: "проверки восстановления",
};

export async function checkBackupFreshness(now: Date = new Date()): Promise<number> {
  let alerts = 0;
  const since = new Date(now.getTime() - BACKUP_STALE_MS);

  const lastOffsiteOk = await prisma.backupRun.findFirst({
    where: { kind: "OFFSITE", success: true },
    orderBy: { finishedAt: "desc" },
    select: { finishedAt: true },
  });
  if (!lastOffsiteOk || lastOffsiteOk.finishedAt < since) {
    const when = lastOffsiteOk ? `последняя удачная ${lastOffsiteOk.finishedAt.toISOString()}` : "удачных нет вовсе";
    await logSystemError("api", `Копия данных наружу не создавалась больше 26 часов (${when}). Проверьте таймер и скрипт бэкапа на сервере.`, {
      dedupKey: "backup-stale:OFFSITE",
      dedupWindowMs: 12 * 60 * 60_000,
      silent: true,
    });
    const { alerted } = await raiseCriticalAlarm({
      tag: "backup:OFFSITE",
      title: "Копия данных не создаётся",
      body: `Выгрузка копии наружу не проходила больше 26 часов (${when}). Проверьте бэкап на сервере.`,
      now,
    });
    if (alerted) alerts++;
  }

  const latestPerKind = await prisma.backupRun.findMany({
    where: { finishedAt: { gte: since } },
    distinct: ["kind"],
    orderBy: { finishedAt: "desc" },
    select: { kind: true, success: true, detail: true, finishedAt: true },
  });
  for (const run of latestPerKind) {
    if (run.success) continue;
    const label = KIND_LABEL[run.kind] ?? run.kind;
    const detail = (run.detail ?? "без пояснения").replace(/\s+/g, " ").slice(0, 120);
    await logSystemError("api", `Копия ${label} (${run.kind}) не удалась: ${detail}`, {
      dedupKey: `backup-failed:${run.kind}`,
      dedupWindowMs: 12 * 60 * 60_000,
      silent: true,
    });
    const { alerted } = await raiseCriticalAlarm({
      tag: `backup:${run.kind}`,
      title: "Копия данных не удалась",
      body: `Копия ${label} не удалась: ${detail}. Проверьте бэкап на сервере.`,
      now,
    });
    if (alerted) alerts++;
  }
  return alerts;
}

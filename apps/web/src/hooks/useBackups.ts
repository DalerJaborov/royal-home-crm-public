import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/** Экран /backups — журнал отчётов ops/backup.sh и ops/restore-drill.sh
 *  (перенос мобильного макета 14.09.2026, шаг 5). Сервер: routes/backups.ts. */
export interface BackupRun {
  id: string;
  kind: string;
  success: boolean;
  sizeLabel: string | null;
  detail: string | null;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
}

export function useBackups() {
  return useQuery({
    queryKey: ["backups"],
    queryFn: () => api<{ latestByKind: BackupRun[]; recent: BackupRun[] }>("/backups"),
    refetchInterval: 300_000,
  });
}

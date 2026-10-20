import { Activity, Archive, CheckCircle2, OctagonAlert } from "lucide-react";
import { useCan } from "../lib/permissions";
import { useBackups } from "../hooks/useBackups";
import { exactDateTime } from "../lib/format";
import { SettingsTabs } from "../components/SectionTabs";

const KIND_LABELS: Record<string, string> = {
  DB: "База данных",
  UPLOADS: "Фото объектов",
  PRIVATE_UPLOADS: "Вложения переписки",
  PROPERTY_VIDEO: "Видео объектов",
  DEAL_DOCS: "Документы сделок",
  OFFSITE: "Оффсайт-копия (R2)",
  RESTORE_DRILL: "Тестовое восстановление",
};

/**
 * «Резервные копии» — экран /backups (перенос мобильного макета 14.09.2026,
 * шаг 5, п.2 плана). Сам бэкап — независимый процесс на VPS (ops/backup.sh,
 * ops/restore-drill.sh), CRM его не запускает и не может. Этот экран лишь
 * ЧИТАЕТ отчёты, которые скрипты теперь шлют best-effort (routes/backups.ts,
 * POST /report) — до этой правки в базе не было ни одной строки, только
 * Telegram-алерт при сбое, поэтому до первого прогона обновлённых скриптов
 * список честно пуст.
 */
export function Backups() {
  const can = useCan();
  const allowed = can("auditLog.view");
  const { data, isLoading, isError } = useBackups();

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Резервные копии</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <Activity className="i" aria-hidden />
              </span>
              <p>Этот раздел доступен только тем, у кого есть право на журнал ошибок.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const latestByKind = data?.latestByKind ?? [];
  const recent = data?.recent ?? [];
  // Вкладки раздела «Здоровье системы» (перенос меню 15.09.2026) — тот же
  // набор, что в pages/Health.tsx.
  const healthTabs = [
    { to: "/health", label: "Здоровье", end: true, permission: "auditLog.view" as const },
    { to: "/integrations", label: "Интеграции и каналы", permission: "auditLog.view" as const },
    { to: "/backups", label: "Резервные копии", permission: "auditLog.view" as const },
  ];

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Резервные копии</h1>
            <p className="sub">Бэкап делает независимый процесс на сервере — здесь только отчёты о его прогонах.</p>
          </div>
        </div>

        <SettingsTabs />

        {isLoading ? (
          <div className="card tight">
            <div className="state">
              <span className="sk w40" /> Загружаем журнал
            </div>
          </div>
        ) : isError ? (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" /> Журнал не загрузился, обновите страницу
            </div>
          </div>
        ) : latestByKind.length === 0 ? (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <Archive className="i" aria-hidden />
              </span>
              <p>
                Нет данных: бэкап-скрипты на сервере ещё ни разу не отправили отчёт в CRM (или приём отчётов не
                настроен ключом BACKUP_REPORT_API_KEY). До этой правки бэкапы работали как обычно, просто CRM про них
                не знала — статус смотрите в Telegram-канале алертов или логах `/var/log/crm-backup.log` на сервере.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="card tight">
              <div className="sec-h">
                <h2>Последний прогон по каждому шагу</h2>
              </div>
              <div className="list">
                {latestByKind.map((r) => (
                  <div className="row wrapt" key={r.kind}>
                    <span className={`dot ${r.success ? "ok" : "crit"}`} aria-hidden="true" />
                    <div className="t">
                      <b>{KIND_LABELS[r.kind] ?? r.kind}</b>
                      <span>
                        {r.success ? "успешно" : "сбой"}
                        {r.sizeLabel ? `, ${r.sizeLabel}` : ""}
                        {r.detail ? ` · ${r.detail}` : ""}
                      </span>
                    </div>
                    <span className="meta">{exactDateTime(r.finishedAt)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card tight">
              <div className="sec-h">
                <h2>История</h2>
                <span className="note">последние {recent.length}</span>
              </div>
              <div className="list">
                {recent.map((r) => (
                  <div className="row wrapt" key={r.id}>
                    {r.success ? (
                      <CheckCircle2 className="i" style={{ color: "var(--ok)" }} aria-hidden="true" />
                    ) : (
                      <OctagonAlert className="i" style={{ color: "var(--crit)" }} aria-hidden="true" />
                    )}
                    <div className="t">
                      <b>{KIND_LABELS[r.kind] ?? r.kind}</b>
                      <span>
                        {r.sizeLabel ?? (r.success ? "успешно" : "сбой")}
                        {r.detail ? ` · ${r.detail}` : ""}
                      </span>
                    </div>
                    <span className="meta">{exactDateTime(r.finishedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

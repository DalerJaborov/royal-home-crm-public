import { Activity, CheckCircle2, ChevronRight, CircleDashed, OctagonAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useCan } from "../lib/permissions";
import { useIntegrations } from "../hooks/useIntegrations";
import { exactDateTime } from "../lib/format";
import { StatTile } from "../components/ui/StatTile";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";

function scrollToChannels() {
  document.getElementById("integrations-channels")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
import { SettingsTabs } from "../components/SectionTabs";

/**
 * «Интеграции и каналы» — экран /integrations (перенос мобильного макета
 * 14.09.2026, шаг 5, п.2 плана: единственный экран макета без вообще какой-либо
 * реальной основы, до этой правки). Сервер: routes/integrations.ts, читает
 * снимок ночной самопроверки (IntegrationHealthSnapshot), не гоняет проверки
 * заново на каждое открытие — см. комментарий в модели schema.prisma.
 *
 * Один компонент на обе ширины (правило проекта с 09.09.2026): узкую раскладку
 * делают медиазапросы `.rh2 .screens`, отдельного Mobile* не заводим.
 */
export function Integrations() {
  const can = useCan();
  const allowed = can("auditLog.view");
  const { data, isLoading, isError, refetch, isRefetching } = useIntegrations();
  const navigate = useNavigate();

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Интеграции и каналы</h1>
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

  const channels = data?.channels ?? [];
  const alive = channels.filter((c) => c.ok === true).length;
  const broken = channels.filter((c) => c.ok === false).length;
  const notConfigured = channels.filter((c) => c.ok === null).length;
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
            <h1>Интеграции и каналы</h1>
            <p className="sub">Статус — по ночной самопроверке внешних доступов, не по живому опросу при открытии.</p>
          </div>
        </div>

        <SettingsTabs />

        {isLoading ? (
          <div className="card tight">
            <div className="state">
              <span className="sk w40" /> Загружаем снимок проверки
            </div>
          </div>
        ) : isError ? (
          <div className="card tight">
            <Rh2ErrorState
              message="Не удалось загрузить статус каналов. Попробуйте ещё раз."
              onRetry={() => refetch()}
              retrying={isRefetching}
            />
          </div>
        ) : channels.length === 0 ? (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <CircleDashed className="i" aria-hidden />
              </span>
              <p>
                Нет данных: ночная проверка ещё не сохранила ни одного снимка (первый прогон — в течение суток после
                выката этой правки). Раньше и на самом деле нечего было показать.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="tiles">
              <StatTile
                icon={CheckCircle2}
                label="Живые"
                value={alive}
                line="ключ принят, доступ есть"
                onClick={scrollToChannels}
                title="Список каналов ниже на этом экране"
              />
              <StatTile
                icon={OctagonAlert}
                label="Сломаны"
                value={broken}
                line="проверить в Настройках → Ключи"
                critical={broken > 0}
                onClick={scrollToChannels}
                title="Список каналов ниже на этом экране"
              />
              <StatTile
                icon={CircleDashed}
                label="Не настроены"
                value={notConfigured}
                line="канал не используется"
                onClick={scrollToChannels}
                title="Список каналов ниже на этом экране"
              />
            </div>

            <div className="card tight" id="integrations-channels">
              <div className="sec-h">
                <h2>Каналы</h2>
                <span className="note">
                  обновлено {exactDateTime(channels.reduce((max, c) => (c.checkedAt > max ? c.checkedAt : max), channels[0].checkedAt))}
                </span>
              </div>
              <div className="list">
                {channels.map((c) => (
                  <div
                    className="row wrapt"
                    key={c.name}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/integrations/${encodeURIComponent(c.name)}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") navigate(`/integrations/${encodeURIComponent(c.name)}`);
                    }}
                  >
                    <span
                      className={`dot ${c.ok === true ? "ok" : c.ok === false ? "crit" : ""}`}
                      aria-hidden="true"
                    />
                    <div className="t">
                      <b>{c.name}</b>
                      <span>
                        {c.ok === true ? "жив" : c.ok === false ? "сломан" : "не настроен"}
                        {c.detail ? ` · ${c.detail}` : ""}
                      </span>
                    </div>
                    <span className="meta">
                      <ChevronRight className="i" aria-hidden="true" />
                    </span>
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

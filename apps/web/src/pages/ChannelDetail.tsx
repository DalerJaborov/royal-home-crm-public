import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useMemo, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGoBack } from "../hooks/useGoBack";
import { ChevronLeft, OctagonAlert, Radar, Settings as SettingsIcon } from "lucide-react";
import { useCan } from "../lib/permissions";
import { useIntegrations } from "../hooks/useIntegrations";
import { exactDateTime } from "../lib/format";
import { useCleanShell } from "../hooks/useCleanShell";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { PageHeader } from "../components/rh2/PageHeader";
import { CButton, CCard, CChip } from "../components/clean/ui";

// Тот же приём, что apps/web/src/pages/TeamMemberDetail.tsx: макет
// `renderChannelDetail` рисует шапку/быстрые действия классами `.chead`/`.qa`,
// которые реально стилизованы только внутри `.rh2 .mh` (theme-2026-mobile-home.css),
// а этот экран — обычная страница, не главная роли. MH_HOST переносит те же
// поля оболочки, что даёт AppLayout, внутрь ручной обёртки `.rh2 .mh`.
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/**
 * Карточка канала — отдельный экран (перенос мобильного макета 14.09.2026,
 * функция `renderChannelDetail`). Раньше вместо перехода-вглубь из списка
 * интеграций была только длинная вкладка настроек `ChannelsTab.tsx` за правом
 * `settings.manage`.
 *
 * Данные — тот же `useIntegrations()`, что уже использует `Integrations.tsx`
 * (снимок ночной самопроверки: name/ok/detail/checkedAt), эндпоинт не новый.
 *
 * «Переподключить» из макета НЕ заведена: в API нет эндпоинта, который
 * переподключал бы конкретный канал (grep по routes/ — только внутренняя
 * переподписка АТС/live-voice, не команда для конкретного канала списка).
 * Выдуманной кнопки, которая ничего не делает, здесь не будет — вместо неё
 * переход в настройки канала, как и «Настройки» рядом.
 */
export function ChannelDetail() {
  const clean = useCleanShell();
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  // Шаг назад вместо жёсткого перехода в корень раздела: иначе возврат
  // терял срез и место в списке (разбор в hooks/useGoBack.ts).
  const goBack = useGoBack("/integrations");
  const can = useCan();
  const allowed = can("auditLog.view");
  const { data, isLoading, isError, isFetching, refetch } = useIntegrations(allowed);

  // Router parameters are already decoded, including a literal '%' in a name.
  const decodedName = name ?? "";
  const channel = useMemo(
    () => data?.channels.find((c) => c.name === decodedName),
    [data, decodedName]
  );

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
              <p>Этот раздел доступен только тем, у кого есть право на журнал ошибок.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (clean) return (
    <Rh2Screen title="Канал интеграции" back="/integrations" onBack={goBack} className="clean-channel-detail">
      <PageHeader title={decodedName || "Канал"} sub="Снимок ночной проверки. Открытие страницы не запускает проверку внешнего сервиса."
        actions={<CButton className="clean-channel-back" variant="soft" onClick={goBack}><ChevronLeft size={20} aria-hidden />Назад к списку каналов</CButton>} />
      {isLoading && <CCard role="status" aria-busy="true">Загружаем снимок канала…</CCard>}
      {isError && <CCard role="alert"><h2>Не удалось обновить снимок</h2><p>{channel ? "Ниже показаны последние доступные данные." : "Статус канала неизвестен. Попробуйте ещё раз."}</p><CButton variant="soft" onClick={() => void refetch()}>Повторить</CButton></CCard>}
      {!isLoading && !isError && !channel && <CCard><h2>Канал не найден в снимке</h2><p>Такого канала нет в последней ночной проверке. Это не подтверждает ошибку подключения.</p><CButton variant="soft" onClick={goBack}>Все каналы</CButton></CCard>}
      {channel && <div className="clean-channel-grid">
        <CCard><div className="clean-channel-state"><span className="clean-channel-icon"><Radar size={28} aria-hidden /></span><div><h2>Состояние канала</h2><CChip tone={channel.ok === true ? "ok" : channel.ok === false ? "crit" : "gray"}>{channel.ok === true ? "Работает" : channel.ok === false ? "Есть ошибка" : "Не настроен"}</CChip></div></div><p>По снимку от {exactDateTime(channel.checkedAt)}.</p></CCard>
        <CCard><h2>Результат проверки</h2><p>{channel.detail || "Ночная проверка не оставила пояснения для этого канала."}</p><div className="clean-channel-actions">{can("settings.view") && <CButton onClick={() => navigate("/settings?tab=channels")}><SettingsIcon size={20} aria-hidden />Настройки канала</CButton>}<CButton variant="soft" onClick={() => navigate("/health")}><OctagonAlert size={20} aria-hidden />Журнал ошибок</CButton><CButton variant="soft" disabled={isFetching} onClick={() => void refetch()}>Обновить снимок</CButton></div></CCard>
      </div>}
    </Rh2Screen>
  );
  return (
    <div className="rh2" style={MH_HOST}>
      <div className="mh">
        <ShellOwnHeader />
        <div className="top">
          <button type="button" className="ico card" aria-label="Назад" onClick={goBack}>
            <ChevronLeft className="i" aria-hidden="true" />
          </button>
          <div className="grow" style={{ fontSize: 14, color: "var(--muted)" }}>
            Интеграции · {decodedName}
          </div>
        </div>
        <div className="body">
          {isLoading && (
            <div className="card-s" style={{ padding: 16 }}>
              <div className="quiet">
                <div className="ln">Загружаем канал…</div>
              </div>
            </div>
          )}

          {isError && (
            <div className="card-s" style={{ padding: 16 }}>
              <div className="quiet">
                <div className="ln">
                  <i className="c" aria-hidden="true" />
                  <span>Снимок не загрузился, обновите страницу</span>
                </div>
              </div>
            </div>
          )}

          {!isLoading && !isError && !channel && (
            <div className="card-s" style={{ padding: 16 }}>
              <div className="quiet">
                <div className="ln">
                  <i className="c" aria-hidden="true" />
                  <span>Нет данных: такого канала нет в последнем снимке ночной проверки.</span>
                </div>
              </div>
            </div>
          )}

          {channel && (
            <>
              <div className="chead">
                <span
                  className="av"
                  style={{
                    width: 64,
                    height: 64,
                    fontSize: 22,
                    background:
                      channel.ok === true ? "var(--lime-bg, var(--soft))" : channel.ok === false ? "var(--crit-bg, var(--soft))" : "var(--soft)",
                  }}
                >
                  <Radar className="i" aria-hidden="true" />
                </span>
                <h1 className="n">{channel.name}</h1>
                <div className="tags">
                  <span className={`chip ${channel.ok === true ? "lime" : channel.ok === false ? "crit" : "lav"}`}>
                    {channel.ok === true ? "жив" : channel.ok === false ? "сломан" : "не настроен"}
                    {channel.detail ? ` · ${channel.detail}` : ""}
                  </span>
                </div>
              </div>

              <div className="qa" role="group" aria-label="Быстрые действия" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
                <button type="button" onClick={() => navigate("/settings?tab=channels")}>
                  <SettingsIcon className="i" aria-hidden="true" />
                  Настройки
                </button>
                <button type="button" onClick={() => navigate("/health")}>
                  <OctagonAlert className="i" aria-hidden="true" />
                  Ошибки
                </button>
              </div>

              <section className="sec">
                <div className="sec-t">
                  <h2>Коротко</h2>
                </div>
                <div className="card-s" style={{ padding: 14 }}>
                  {channel.detail ? (
                    <p style={{ margin: 0, fontSize: 14, color: "var(--body)" }}>{channel.detail}</p>
                  ) : (
                    <div className="quiet">
                      <div className="ln">
                        <span>Нет данных: ночная проверка не оставила пояснения для этого канала.</span>
                      </div>
                    </div>
                  )}
                  <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--muted)" }}>
                    Обновлено {exactDateTime(channel.checkedAt)}
                  </p>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

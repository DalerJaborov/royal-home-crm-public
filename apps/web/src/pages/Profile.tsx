import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useServerSyncedFields } from "../hooks/useServerSyncedForm";
import { useNavigate } from "react-router-dom";
import { useGoBack } from "../hooks/useGoBack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUiPrefs } from "../store/uiPrefs";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCleanShell } from "../hooks/useCleanShell";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { Tabs } from "../components/rh2/Tabs";
import { useInstallPrompt } from "../hooks/useInstallPrompt";
import {
  usePauseLeads,
  useResumeLeads,
  useMyProfile,
  useUpdateMyProfile,
  useUploadMyAvatar,
  useCreateTelegramLink,
  useUnlinkTelegram,
  useUpdateMontageCopies,
  canReceiveMontageCopies,
  useSetTelegramModeration,
  useSetClipReviewTelegram,
} from "../hooks/useMe";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useBranding } from "../hooks/useBranding";
import { useSettings } from "../hooks/useSettings";
import { api } from "../lib/api";
import { signOut } from "../lib/signOut";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import { useCan } from "../lib/permissions";
import { ROLE_LABELS } from "../lib/roles";
import { AppearanceSettings } from "../components/AppearanceSettings";
import { TwoFactorSettings } from "../components/TwoFactorSettings";
import { PasskeySettings } from "../components/PasskeySettings";
import { StepUpDialog } from "../components/StepUpDialog";
import { claimStepUp } from "../lib/stepUpOwners";
import { ApiError } from "../lib/api";
import { ProtoToggle } from "../components/ProtoToggle";
import { RoyalScoreCard } from "../components/RoyalScoreCard";
import { MutationError } from "../components/MutationError";
import { AVATAR_TONES, initials } from "../lib/theme2026Person";
import { dushanbeDateTime } from "../lib/date";
import { VoiceNotePlayer } from "../components/VoiceNotePlayer";
import { MhQuiet } from "../components/home/mh/MhScreen";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react";

/**
 * «Мой профиль»: личные данные, вход и вид приложения.
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/profile.html). Порядок секций и подписи из
 * прототипа: «Кто я» (`.prof-h`), «Вид приложения» (`.modes`), «Приём новых
 * лидов», «Личные данные» (`.fgrid`/`.fld`), «Вход и безопасность» (`.mod`),
 * «Активные устройства», «Уведомления на это устройство» (`.tgl`), «Привязки»,
 * состояния. Классы прототипные, экран включает эталон обёрткой
 * `<div className="rh2 screens">`.
 *
 * НА ПК разметка прежняя (эта функция): `.card`, `.mod`, `.fgrid`, `.list`
 * перестраиваются медиазапросом самой темы (max-width:820px).
 *
 * НА ТЕЛЕФОНЕ (14.09.2026) — отдельный дизайн из второго макета владельца,
 * мобильного c99db05f (`ProfileMobile` ниже в ЭТОМ ЖЕ файле, `.rh2 .mh`, не
 * `.rh2 screens`). НЕ отдельный файл-двойник: правило проекта («Oversight/
 * MobileOversight», два антифрод-пропуска 22.08 и 30.08) — раздельные файлы
 * молча расходятся, поэтому обе ширины живут в одном модуле и ветвятся по
 * УСТРОЙСТВУ (useMobileUx), а не по вкладке оформления.
 *
 * Разделы, которых в макете нет (Royal Score, история входов, установка
 * приложения, выбор строки приветствия, звуки), НЕ выброшены: одеты в те же
 * прототипные классы.
 */
export function Profile() {
  const { data: profile } = useMyProfile();
  const branding = useBranding();
  const { data: settings } = useSettings();
  const can = useCan();
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const clean = useCleanShell();
  if (mobile && !clean) return <ProfileMobile />;

  function handleLogout() {
    // Тот же выход, что в More/ProfileMenu: общий lib/signOut гасит состояние сразу
    // и снимает push-подписку этого устройства (WEB-PAGES08), без ожидания сети.
    void signOut();
    navigate("/login");
  }

  if (clean) return <CleanProfile profile={profile} royalScoreEnabled={settings?.royalScoreEnabled ?? true} canSettings={can("settings.view")} onLogout={handleLogout} />;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Мой профиль</h1>
            <p className="sub">Личные данные, вход и вид приложения. Видно только вам.</p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={handleLogout}>
              Выйти из CRM
            </button>
          </div>
        </div>

        <AvatarSection />

        <AppearanceSettings />

        {/* Кабинет Royal Score: агенту всегда видно, почему у него такой рейтинг
            и что сделать, чтобы он вырос (требование объяснимости из
            спецификации). Только агенту: место считается среди агентов, у
            руководителя личного портфеля лидов нет, и «место 1 из 4» у него
            означало бы неправду. */}
        {profile?.role === "AGENT" && (settings?.royalScoreEnabled ?? true) && <RoyalScoreCard />}

        {/* Только агенту: приём лидов есть у того, кому их распределяют. */}
        {profile?.role === "AGENT" && <LeadPauseSection />}

        <PersonalInfoSection />

        <section className="card">
          <div className="sec-h stack">
            <h2>Вход и безопасность</h2>
            <span className="note">Двухфакторная защита, вход по отпечатку, автовыход</span>
          </div>
          <TwoFactorSettings />
          <PasskeySettings />
          <AutoLogoutSection />
        </section>

        <ActiveSessionsSection />
        <LoginHistorySection />
        <PushNotificationsSection />

        <section className="card">
          <div className="sec-h stack">
            <h2>Привязки</h2>
            <span className="note">Служебные, не каналы связи с клиентами</span>
          </div>
          {canReceiveMontageCopies(profile?.role) && <MontageCopiesSection />}
          {(profile?.role === "AGENT" || profile?.isVideoMontajer || profile?.telegramLinked || profile?.montageCopiesTelegram || profile?.permissions.includes("properties.moderate")) && <TelegramLinkSection />}
          <InstallAppSection />
        </section>

        {/* Мостик в «Настройки CRM»: только тем, кому раздел доступен. */}
        {can("settings.view") && (
          <div className="card tight">
            <div className="mod">
              <div className="t">
                <b>Настройки CRM</b>
                <span>Комиссия, лиды, бот, ИИ. Общие правила агентства, а не личные.</span>
              </div>
              <div className="acts">
                <button className="pill ghost sm" type="button" onClick={() => navigate("/settings")}>
                  Открыть
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="state">
          {profile ? `${profile.fullName}, ${ROLE_LABELS[profile.role]}` : "Профиль"}
          {branding?.companyName ? `, ${branding.companyName}` : ""}
        </p>
      </div>
    </div>
  );
}

const PROFILE_SECTIONS = [
  { id: "details", label: "Личные данные" },
  { id: "appearance", label: "Вид и приложение" },
  { id: "notifications", label: "Уведомления" },
  { id: "security", label: "Безопасность" },
  { id: "sessions", label: "Устройства" },
  { id: "connections", label: "Подключения" },
] as const;
type ProfileSection = typeof PROFILE_SECTIONS[number]["id"];

/** One responsive Clean composition. The existing section controllers below
 * remain responsible for validation, saving, permissions and errors. Legacy
 * ProfileMobile is still selected for AGENT phones by the shell device policy. */
function CleanProfile({ profile, royalScoreEnabled, canSettings, onLogout }: {
  profile: ReturnType<typeof useMyProfile>["data"];
  royalScoreEnabled: boolean;
  canSettings: boolean;
  onLogout: () => void;
}) {
  const [section, setSection] = useState<ProfileSection>("details");
  const [visited, setVisited] = useState(() => new Set<ProfileSection>(["details"]));
  const navigate = useNavigate();
  const selectSection = (next: ProfileSection) => {
    setSection(next);
    setVisited((previous) => previous.has(next) ? previous : new Set([...previous, next]));
  };
  return <Rh2Screen title="Мой профиль" className="clean-profile-page">
    <header className="pg-h">
      <div><h1>Мой профиль</h1><p className="sub">Личные данные, приложение и безопасность. Видно только вам.</p></div>
      <button className="pill ghost" type="button" onClick={onLogout}>Выйти из CRM</button>
    </header>
    <Tabs options={PROFILE_SECTIONS} value={section} onChange={selectSection} idPrefix="profile-section" aria-label="Разделы профиля" className="clean-profile-tabs" />
    {PROFILE_SECTIONS.map(({ id }) => <section key={id} role="tabpanel" id={`profile-section-panel-${id}`} aria-labelledby={`profile-section-tab-${id}`} hidden={section !== id} className="clean-profile-panel">
      {/* Mount on first visit, then retain fields while the panel is hidden. */}
      {visited.has(id) && <>
      {id === "details" && <>
        <AvatarSection />
        <PersonalInfoSection />
        {profile?.role === "AGENT" && royalScoreEnabled && <RoyalScoreCard />}
        {profile?.role === "AGENT" && <LeadPauseSection />}
        {canSettings && <div className="card tight"><div className="mod"><div className="t"><b>Настройки CRM</b><span>Общие правила агентства: комиссия, лиды и ИИ.</span></div><button className="pill ghost" type="button" onClick={() => navigate("/settings")}>Открыть</button></div></div>}
      </>}
      {id === "appearance" && <><AppearanceSettings /><section className="card"><div className="sec-h stack"><h2>Приложение на устройстве</h2><span className="note">Быстрый запуск CRM с рабочего стола</span></div><InstallAppSection showStatus /></section></>}
      {id === "notifications" && <PushNotificationsSection showUnavailable />}
      {id === "security" && <section className="card"><div className="sec-h stack"><h2>Вход и безопасность</h2><span className="note">Двухфакторная защита, вход по отпечатку, автовыход</span></div><TwoFactorSettings /><PasskeySettings /><AutoLogoutSection /></section>}
      {id === "sessions" && <><ActiveSessionsSection /><LoginHistorySection /></>}
      {id === "connections" && <section className="card"><div className="sec-h stack"><h2>Служебные подключения</h2><span className="note">Личные привязки для работы, не клиентские каналы</span></div>{canReceiveMontageCopies(profile?.role) && <MontageCopiesSection />}{(profile?.role === "AGENT" || profile?.isVideoMontajer || profile?.telegramLinked || profile?.montageCopiesTelegram || profile?.permissions.includes("properties.moderate")) ? <TelegramLinkSection /> : <p className="state">Для вашей роли нет дополнительных служебных подключений.</p>}</section>}
      </>}
    </section>)}
  </Rh2Screen>;
}

// Та же область, что в TeamMemberDetail.tsx / components/home/mh/MhScreen.tsx:
// оболочка (AppLayout) даёт содержимому поля `px-5 pt-4` и запас снизу под
// нижнюю панель, артефакт держит поля сам.
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/** Тумблер макета: `<button class="tg" role="switch" aria-checked>` (theme-2026-mobile-home.css). */
function MhToggle({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button type="button" className="tg" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onToggle(!on)}>
      <i />
    </button>
  );
}

/**
 * «Профиль» на телефоне — дизайн мобильного макета c99db05f.
 *
 * Источник: `docs/pult/theme-2026/artifact-c99db05f-mobile-nav-14-09.html`,
 * `<section data-scr="profile">` + `function renderProfile()`: шапка со
 * стрелкой назад, карточка «кто я» (`.chead`), секция «Доступ» (фото),
 * секция «Уведомления» (push-тумблер), кнопка выхода.
 *
 * НЕ отдельный файл: живёт в том же модуле, что десктопный `Profile()`, и
 * вызывается только оттуда (`if (mobile) return <ProfileMobile />`). Хуки —
 * те же самые (useMyProfile/useUpdateMyProfile/useUploadMyAvatar), кеш
 * react-query общий, версии физически не могут разойтись.
 *
 * ЧЕСТНЫЕ ДАННЫЕ (нет новых эндпоинтов):
 *  - «Фото профиля» → та же мутация, что у десктопной AvatarSection.
 *  - «Вход и безопасность» → те же компоненты, что на ПК (TwoFactorSettings,
 *    PasskeySettings, AutoLogoutSection, ActiveSessionsSection,
 *    LoginHistorySection). До 22.09.2026 на телефоне вместо них стояла
 *    строка-витрина «Passkey — Не подключён»: включить ключ, поднять
 *    двухфакторную защиту или оборвать сессию на потерянном телефоне с
 *    телефона было нельзя вовсе. Пароля в системе нет (19.10.2026): вход по
 *    коду из СМС и по отпечатку / Face ID (PasskeySettings).
 *  - «Push-уведомления» → usePushNotifications(), тот же хук, что в Настройках.
 *  - «Звук на новый лид» из макета ОПУЩЕН честно: отдельного серверного
 *    тумблера звука на лид в CRM нет (есть общий системный звук браузера) —
 *    выдумывать поле нельзя (правило проекта). Вместо строки — `.quiet`.
 */
function ProfileMobile() {
  const navigate = useNavigate();
  const { data: profile } = useMyProfile();
  const { data: settings } = useSettings();
  const uploadAvatar = useUploadMyAvatar();
  const push = usePushNotifications();

  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // «Назад» через useGoBack: прежняя проверка window.history.length считала и
  // страницы ДО приложения — открыв CRM по ссылке из мессенджера, человек
  // уходил кнопкой обратно в мессенджер (разбор в hooks/useGoBack.ts).
  const back = useGoBack("/more");

  function handleLogout() {
    void signOut();
    navigate("/login");
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError(null);
    try {
      await uploadAvatar.mutateAsync(file);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Не удалось загрузить фото");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="rh2" style={MH_HOST}>
      <div className="mh">
        <ShellOwnHeader />
        <div className="top">
          <button type="button" className="ico" aria-label="Назад" onClick={back}>
            <ChevronLeft className="i" aria-hidden="true" />
          </button>
          {/* Заголовок экрана: см. пояснение в Calendar.tsx. Уровень 2, потому
              что ниже стоит <h1> с именем сотрудника — оно и есть главный
              заголовок карточки, а это подпись раздела. 19.09.2026. */}
          <div className="grow" style={{ fontSize: 14, color: "var(--muted)" }} role="heading" aria-level={2}>
            Профиль
          </div>
        </div>
        <div className="body">
          <div className="chead">
            <span className="av lav" style={{ width: 96, height: 96, fontSize: 34, ...AVATAR_TONES[2] }}>
              {profile?.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
              ) : (
                initials(profile?.fullName ?? "")
              )}
            </span>
            <h1 className="n">{profile?.fullName ?? ""}</h1>
            <div className="tags">
              <span className="chip lav">{profile ? ROLE_LABELS[profile.role] : ""}</span>
            </div>
          </div>

          <section className="sec">
            <div className="sec-t">
              <h2>Доступ</h2>
            </div>
            <div className="card-s">
              <div className="row" role="button" tabIndex={0} onClick={() => fileRef.current?.click()}>
                <span className="t">
                  <span className="n">Фото профиля</span>
                  <span className="s">{uploadAvatar.isPending ? "Загрузка…" : "Изменить"}</span>
                </span>
                <ChevronRight className="i" aria-hidden="true" />
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleAvatarChange} />
            {avatarError && (
              <div style={{ marginTop: 8 }}>
                <MhQuiet tone="warn">{avatarError}</MhQuiet>
              </div>
            )}
          </section>

          {/* ВХОД И БЕЗОПАСНОСТЬ НА ТЕЛЕФОНЕ (22.09.2026). Раньше здесь была
              строка «Passkey — Не подключён» БЕЗ кнопки: посмотреть можно,
              включить нельзя. Вместе с ней на телефоне не существовало ни
              двухфакторной защиты, ни автовыхода, ни списка активных устройств
              с кнопкой «Выйти» — а это единственный способ оборвать сессию на
              потерянном телефоне, и именно с телефона человек это и делает.
              Поймано прогоном e2e (набор привязки ключа входа падал на проекте
              mobile).

              Своих копий здесь нет НАМЕРЕННО: это те же самые компоненты, что
              на ПК. Они и так написаны прототипными классами (`.mod`, `.pill`,
              `.list`/`.row`, `.quiet`), которые мобильная тема раскладывает
              сама, — второй экземпляр логики разошёлся бы с первым, ровно как
              разошлись Oversight/MobileOversight. */}
          {/* Обёртка `.scr` — не косметика: ВСЕ прототипные правила этих блоков
              (`.mod`, `.card`, `.list`/`.row`) записаны с предком `.rh2 .scr`,
              а мобильный экран живёт в `.rh2 .mh`. Без неё заголовок блока
              слипался с пояснением в одну строку, а строки устройств ломались
              по букве. Медиазапрос темы (820 px) сам даёт узкую раскладку,
              поэтому поля обнуляем и оставляем только вертикальный ритм. */}
          <div className="scr" style={{ padding: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            {profile?.role === "AGENT" && (settings?.royalScoreEnabled ?? true) && <RoyalScoreCard />}
            {profile?.role === "AGENT" && <LeadPauseSection />}

            <PersonalInfoSection />

            <section className="card">
              <div className="sec-h stack">
                <h2>Вход и безопасность</h2>
                <span className="note">Двухфакторная защита, вход по отпечатку, автовыход</span>
              </div>
              <TwoFactorSettings />
              <PasskeySettings />
              <AutoLogoutSection />
            </section>

            <ActiveSessionsSection />
            <LoginHistorySection />

            <section className="card">
              <div className="sec-h stack">
                <h2>Привязки</h2>
                <span className="note">Служебные, не каналы связи с клиентами</span>
              </div>
              {(profile?.role === "AGENT" || profile?.isVideoMontajer || profile?.telegramLinked || profile?.montageCopiesTelegram || profile?.permissions.includes("properties.moderate")) && <TelegramLinkSection />}
              <InstallAppSection />
            </section>

            <AppearanceSettings />
          </div>

          {canReceiveMontageCopies(profile?.role) && (
            <section className="sec">
              <div className="sec-t">
                <h2>Монтаж</h2>
              </div>
              <div className="card-s">
                <MontageCopiesMobileRow />
              </div>
            </section>
          )}

          <section className="sec">
            <div className="sec-t">
              <h2>Уведомления</h2>
            </div>
            <div className="card-s">
              {push.status === "unsupported" || push.status === "server-disabled" ? (
                <MhQuiet>
                  Push-уведомления недоступны: {push.status === "unsupported" ? "браузер их не поддерживает" : "выключены в настройках агентства"}
                </MhQuiet>
              ) : (
                <div className="sw-toggle">
                  <span className="t">
                    <span className="n" style={{ fontSize: 15 }}>
                      Push-уведомления
                    </span>
                  </span>
                  <MhToggle
                    on={push.status === "subscribed"}
                    label="Push-уведомления"
                    disabled={push.busy || push.status === "denied" || push.status === "loading"}
                    onToggle={(next) => (next ? push.subscribe() : push.unsubscribe())}
                  />
                </div>
              )}
              <MhQuiet>Нет данных: отдельного тумблера «звук на новый лид» в CRM нет, есть только общий звук браузера.</MhQuiet>
            </div>
          </section>

          <button className="btn soft" style={{ width: "100%", marginTop: 6, color: "var(--crit)" }} type="button" onClick={handleLogout}>
            <LogOut className="i" aria-hidden="true" /> Выйти из аккаунта
          </button>
        </div>
      </div>
    </div>
  );
}

/** Карточка «кто я» с загрузкой фото: блок `.prof-h` прототипа. */
function AvatarSection() {
  const { data: profile } = useMyProfile();
  const branding = useBranding();
  const uploadAvatar = useUploadMyAvatar();
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError(null);
    try {
      await uploadAvatar.mutateAsync(file);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Не удалось загрузить фото");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card">
      <div className="prof-h">
        <span className="av xl" style={AVATAR_TONES[2]}>
          {profile?.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }} />
          ) : (
            initials(profile?.fullName ?? "")
          )}
          <i className="pres on" />
        </span>
        <div className="who">
          <h1>{profile?.fullName ?? ""}</h1>
          <p className="sub">
            {[profile ? ROLE_LABELS[profile.role] : null, profile?.phone, branding?.companyName]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="wrap" style={{ marginTop: 12 }}>
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploadAvatar.isPending}
            >
              {uploadAvatar.isPending ? "Загрузка" : "Изменить фото"}
            </button>
            <span className="note" style={{ fontSize: "var(--fs-12)", color: "var(--faint)" }}>
              JPG или PNG, квадратное
            </span>
          </div>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleAvatarChange} />
      {avatarError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{avatarError}</span>
        </div>
      )}
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Это фото видят коллеги в списках и на доске почёта. Из Telegram фото не подтягивается.
        </span>
      </div>
    </section>
  );
}

/** Профиль → Безопасность: автовыход при неактивности. Личная настройка, синкается
 * в БД вместе с оформлением (Agent.preferences.security), применяется хуком
 * useIdleLogout. */
const AUTO_LOGOUT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Никогда" },
  { value: 15, label: "Через 15 минут" },
  { value: 30, label: "Через 30 минут" },
  { value: 60, label: "Через 1 час" },
  { value: 240, label: "Через 4 часа" },
  { value: 480, label: "Через 8 часов" },
];

function AutoLogoutSection() {
  const minutes = useUiPrefs((s) => s.autoLogoutMinutes);
  const setMinutes = useUiPrefs((s) => s.setAutoLogoutMinutes);

  return (
    <div className="mod">
      <div className="t">
        <b>Автовыход</b>
        <span>CRM закроется сама, если ей не пользоваться. Полезно на общем компьютере.</span>
      </div>
      <div className="acts">
        <select
          className="inp"
          style={{ maxWidth: 180 }}
          value={minutes === null ? "" : String(minutes)}
          onChange={(e) => setMinutes(e.target.value === "" ? null : Number(e.target.value))}
          aria-label="Автовыход при неактивности"
        >
          {AUTO_LOGOUT_OPTIONS.map((o) => (
            <option key={o.label} value={o.value === null ? "" : o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

interface ActiveSession {
  id: string;
  device: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

function formatSessionTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Активные устройства (не история, только те, что сейчас реально авторизованы).
 * Лишнее вытесняется, автовыход сам сработает без единого входа с устройства
 * дольше 7 дней. «Выйти» для случая «старый телефон сдох, а сессия там осталась»
 * обрывает её удалённо. */
function ActiveSessionsSection() {
  const qc = useQueryClient();
  const { data } = useQuery<{ maxDevices: number; sessions: ActiveSession[] }>({
    queryKey: ["me", "sessions"],
    queryFn: () => api("/me/sessions"),
    staleTime: 30_000,
  });
  // «Это устройство» точным сравнением id сессии из refresh-cookie (см. GET
  // /auth/session), а не угадыванием по отпечатку браузера. Раньше угаданный
  // отпечаток не совпадал с сессией, заведённой ДО раскатки этой фичи: своё же
  // устройство не подсвечивалось, и кнопка «Выйти» была видна на нём тоже.
  const { data: mySid } = useQuery<{ sid: string | null }>({
    queryKey: ["auth", "session"],
    queryFn: () => api("/auth/session"),
    staleTime: 60_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/me/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "sessions"] }),
  });

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Активные устройства</h2>
        <span className="note">Не больше {data?.maxDevices ?? 3} одновременно, лишнее вытесняется</span>
      </div>
      {!data?.sessions.length ? (
        <p className="state">Нет активных устройств.</p>
      ) : (
        <div className="list">
          {data.sessions.map((s) => {
            const isCurrent = mySid?.sid != null && s.id === mySid.sid;
            return (
              <div className="row" key={s.id}>
                <span className="av" style={{ background: "var(--soft)", color: "var(--muted)" }}>
                  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="5" width="18" height="12" rx="2" />
                    <path d="M8 21h8" />
                  </svg>
                </span>
                <div className="t">
                  <b>{s.device ?? "Неизвестное устройство"}</b>
                  <span>
                    {s.ip ? `IP ${s.ip}` : "IP неизвестен"}, активность {formatSessionTime(s.lastSeenAt)}, вход{" "}
                    {formatSessionTime(s.createdAt)}
                  </span>
                </div>
                {isCurrent && (
                  <span className="chip ok">
                    <span className="dot ok" />
                    Вы сейчас здесь
                  </span>
                )}
                {/* На своём устройстве кнопки нет вовсе, а не «есть, но
                    серая»: нажать её было нельзя и раньше, зато на узком
                    экране она вместе с меткой «Вы сейчас здесь» сжимала
                    название устройства до одной буквы в строке. */}
                {!isCurrent && (
                  <div className="act">
                    <button className="pill ghost sm" type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                      Выйти
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="state">Устройство само отключится, если им не пользовались 7 дней подряд.</p>
    </section>
  );
}

interface LoginLogEntry {
  id: string;
  ip: string | null;
  device: string | null;
  isNewDevice: boolean;
  createdAt: string;
}

/** Сколько записей истории видно сразу. Остальные по кнопке: сервер отдаёт до
 *  тридцати, и все разом превращали раздел в простыню. */
const LOGIN_HISTORY_PAGE = 5;

/** История входов в свою учётку: когда, с какого устройства и IP. */
function LoginHistorySection() {
  const { data: logins } = useQuery<LoginLogEntry[]>({
    queryKey: ["me", "logins"],
    queryFn: () => api("/me/logins"),
    staleTime: 60_000,
  });
  const [visible, setVisible] = useState(LOGIN_HISTORY_PAGE);

  const total = logins?.length ?? 0;
  const shown = logins?.slice(0, visible) ?? [];
  const rest = total - shown.length;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>История входов</h2>
        <span className="note">Незнакомое устройство: нажмите «Выйти» у него и сообщите директору</span>
      </div>
      {!total ? (
        <p className="state">Записей пока нет: журнал заполняется при каждом новом входе.</p>
      ) : (
        <>
          <div className="list">
            {shown.map((l) => (
              <div className="row" key={l.id}>
                <div className="t">
                  <b>{l.device ?? "Неизвестное устройство"}</b>
                  <span>
                    {l.ip ? `IP ${l.ip}` : "IP неизвестен"},{" "}
                    {new Date(l.createdAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe",
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {l.isNewDevice && <span className="chip warn">новое устройство</span>}
              </div>
            ))}
          </div>
          <p className="state">
            {/* «из 30 последних», а не «из 30»: сервер отдаёт только последние
                тридцать входов, и без этого слова счётчик читался бы как «за всё
                время вы заходили 30 раз». */}
            Показаны {shown.length} из {total} последних.{" "}
            {rest > 0 && (
              <button className="lk" type="button" onClick={() => setVisible((v) => v + LOGIN_HISTORY_PAGE * 2)}>
                Показать ещё ({Math.min(rest, LOGIN_HISTORY_PAGE * 2)})
              </button>
            )}{" "}
            {visible > LOGIN_HISTORY_PAGE && (
              <button className="lk" type="button" onClick={() => setVisible(LOGIN_HISTORY_PAGE)}>
                Свернуть
              </button>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/** Установка CRM как приложения (PWA). Строка видна, только когда установка
 * реально доступна: в установленном приложении и в браузерах без поддержки она
 * не показывается, чтобы не путать людей мёртвой кнопкой. */
function InstallAppSection({ showStatus = false }: { showStatus?: boolean } = {}) {
  const { state, install } = useInstallPrompt();
  if (state === "installed" || state === "unavailable") return showStatus
    ? <p className="state">{state === "installed" ? "CRM уже открыта как установленное приложение." : "Установка из этого браузера сейчас недоступна. Можно продолжать работать в веб-версии."}</p>
    : null;

  return (
    <div className="mod">
      <div className="t">
        <b>Установить CRM как приложение</b>
        <span>
          {state === "available"
            ? "Появится на главном экране и откроется без адресной строки: быстрее."
            : "На iPhone: откройте CRM в Safari, нажмите «Поделиться» (квадрат со стрелкой), затем «На экран Домой»."}
        </span>
      </div>
      {state === "available" && (
        <div className="acts">
          <button className="pill ghost sm" type="button" onClick={install}>
            Установить
          </button>
        </div>
      )}
    </div>
  );
}

function PushNotificationsSection({ showUnavailable = false }: { showUnavailable?: boolean } = {}) {
  const { status, busy, error, subscribe, unsubscribe } = usePushNotifications();
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  if (status === "unsupported" || status === "server-disabled") return showUnavailable
    ? <section className="card"><div className="sec-h"><h2>Уведомления на это устройство</h2></div><p className="state">{status === "unsupported" ? "Этот браузер не поддерживает push-уведомления." : "Push-уведомления пока не настроены на сервере."} Уведомления внутри CRM остаются доступны.</p></section>
    : null;

  const subscribed = status === "subscribed";
  const denied = status === "denied";

  async function handleTest() {
    setTestState("sending");
    try {
      await api("/push/test", { method: "POST" });
      setTestState("sent");
    } catch {
      setTestState("failed");
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Уведомления на это устройство</h2>
        <span className="note">Служебные сигналы приходят всегда</span>
      </div>

      <div className="mod">
        <div className="t">
          <b>Push-уведомления</b>
          <span>
            {denied
              ? "Уведомления заблокированы в настройках браузера: разрешите их для этого сайта, чтобы включить."
              : "Новые лиды, переназначения и смена этапа сделки приходят сразу, даже если CRM свёрнута."}
          </span>
          {testState === "failed" && <span>Тестовое уведомление не отправилось. Проверьте, что уведомления включены.</span>}
          {testState === "sent" && (
            <span>Отправлено. Если уведомление не появилось за минуту, проверьте настройки уведомлений системы.</span>
          )}
          {status === "error" && error && <span>Не получилось: {error}. Попробуйте ещё раз.</span>}
        </div>
        <div className="acts">
          {subscribed && (
            <button className="pill ghost sm" type="button" disabled={testState === "sending"} onClick={handleTest}>
              {testState === "sending" ? "Отправляем" : "Проверить"}
            </button>
          )}
          <ProtoToggle
            on={subscribed}
            label="Push-уведомления"
            disabled={busy || denied || status === "loading"}
            onToggle={(next) => (next ? subscribe() : unsubscribe())}
          />
        </div>
      </div>

      {subscribed && <PushKindsList />}

      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Служебные сигналы (ключи, сбои, эскалации) приходят всегда, их выключить нельзя.
        </span>
      </div>
    </section>
  );
}

/**
 * Что именно присылать этому сотруднику.
 *
 * До 11.08.2026 выбор был «всё или ничего» на устройство: агент, которому мешал
 * поток сообщений клиентов, отключал заодно и новые лиды, то есть ровно то, ради
 * чего уведомления и заводились.
 *
 * Положение тумблера меняется сразу, до ответа сервера (правило Настроек от
 * 11.08.2026), а отказ откатывает его назад. Подпись по ТЕКУЩЕМУ положению, а не
 * по тому, что произойдёт при нажатии.
 */
function PushKindsList() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ kinds: { key: string; label: string; hint: string; enabled: boolean }[] }>({
    queryKey: ["push-preferences"],
    queryFn: () => api("/push/preferences"),
  });

  const toggle = useMutation({
    // Без JSON.stringify: api() сериализует body сам, а двойная сериализация
    // отправляла на сервер JSON-строку-литерал, Zod отвечал 400, и тумблеры
    // «Что присылать на это устройство» не сохранялись НИКОГДА (аудит №4).
    mutationFn: (vars: { kind: string; enabled: boolean }) => api("/push/preferences", { method: "PATCH", body: vars }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["push-preferences"] });
      const previous = queryClient.getQueryData(["push-preferences"]);
      queryClient.setQueryData(["push-preferences"], (old: typeof data) =>
        old ? { kinds: old.kinds.map((k) => (k.key === vars.kind ? { ...k, enabled: vars.enabled } : k)) } : old
      );
      return { previous, epoch: currentSessionEpoch() };
    },
    onError: (_err, _vars, context) => {
      rollbackInSameSession(context?.epoch, () => queryClient.setQueryData(["push-preferences"], context?.previous));
    },
    onSettled: (result, _err, _vars, context) => {
      // Ответ прежней сессии в чужой кэш не пишем (WEB-01).
      if (result) rollbackInSameSession(context?.epoch, () => queryClient.setQueryData(["push-preferences"], result));
    },
  });

  if (!data) return null;

  return (
    <>
      {data.kinds.map((kind) => (
        <div className="mod" key={kind.key}>
          <div className="t">
            <b>{kind.label}</b>
            <span>{kind.enabled ? kind.hint : "Выключено: эти уведомления не приходят."}</span>
          </div>
          <div className="acts">
            <ProtoToggle
              on={kind.enabled}
              label={kind.label}
              onToggle={(next) => toggle.mutate({ kind: kind.key, enabled: next })}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function PersonalInfoSection() {
  const { data: profile } = useMyProfile();
  const updateProfile = useUpdateMyProfile();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // Телефон это логин: смена номера требует свежего подтверждения личности —
  // сервер отвечает 428, окно подтверждения (код СМС / приложение) открываем
  // здесь же и после него повторяем сохранение.
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => claimStepUp(), []);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const phoneChanged = Boolean(profile && phone && phone !== profile.phone);

  useServerSyncedFields(
    profile && {
      fullName: profile.fullName,
      phone: profile.phone,
      email: profile.email ?? "",
    },
    {
      fullName: [fullName, setFullName],
      phone: [phone, setPhone],
      email: [email, setEmail],
    }
  );

  async function save() {
    setError(null);
    setSuccess(false);
    try {
      await updateProfile.mutateAsync({ fullName, phone, email });
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 428) {
        setConfirmOpen(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    void save();
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Личные данные</h2>
        <span className="note">Телефон служит логином</span>
      </div>
      <form onSubmit={handleSave} className="fgrid">
        <label className="fld">
          <span className="lab">Имя</span>
          <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} aria-label="Имя" />
        </label>
        <label className="fld">
          <span className="lab">Телефон</span>
          <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Телефон" />
        </label>
        {phoneChanged && (
          <div className="wide">
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Телефон — это логин. При сохранении подтвердите, что это вы, кодом.</span>
            </div>
          </div>
        )}
        <label className="fld">
          <span className="lab">Почта</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="необязательно" />
        </label>
        {error && (
          <div className="wide">
            <div className="quiet crit">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          </div>
        )}
        <div className="wide wrap">
          <button className="pill" type="submit" disabled={updateProfile.isPending}>
            {updateProfile.isPending ? "Сохранение" : "Сохранить"}
          </button>
          {success && <span className="saved on">Сохранено</span>}
        </div>
      </form>
      {confirmOpen && (
        <StepUpDialog
          description="Смена номера телефона меняет вход в учётную запись. Подтвердите, что это вы."
          onConfirmed={() => {
            setConfirmOpen(false);
            void save();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * «Не принимаю лиды»: временный выход из распределения.
 *
 * Зачем это агенту: на больничном или в отпуске он молча копил непринятые заявки,
 * за которые ему потом падал KPI, а клиенты в это время ждали ответа.
 *
 * Зачем ограничения: срок обрезается потолком на сервере, а включить паузу заново
 * нельзя, пока не пройдёт «остыть». Без них тумблер быстро стал бы способом не
 * работать, а не способом честно предупредить.
 *
 * KPI во время паузы идёт как обычно, об этом сказано прямо в подсказке, иначе
 * первое же включение будет сделано ради того, чтобы спрятать просрочки.
 */
function LeadPauseSection() {
  const { data: profile } = useMyProfile();
  const pause = usePauseLeads();
  const resume = useResumeLeads();
  const [hours, setHours] = useState("24");

  const pausedUntil = profile?.leadsPausedUntil ? new Date(profile.leadsPausedUntil) : null;
  const isPaused = !!pausedUntil && pausedUntil.getTime() > Date.now();
  const frozen = !!profile?.frozenAt;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Приём новых лидов</h2>
        <span className="note">Текущие клиенты остаются за вами в любом случае</span>
      </div>

      {frozen ? (
        // Заморозка это решение руководителя, и снять её агент не может.
        // Показываем причину: «почему мне не приходят клиенты» не должно быть
        // загадкой.
        <>
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              Выдача лидов остановлена руководителем.
              {profile?.frozenReason ? ` Причина: ${profile.frozenReason}.` : ""} Текущие клиенты остаются у вас,
              новые не назначаются. Снять может только руководитель.
            </span>
          </div>
          {profile?.frozenReasonVoiceUrl && <VoiceNotePlayer url={profile.frozenReasonVoiceUrl} />}
        </>
      ) : isPaused && profile?.leadsPausedBy ? (
        // Паузу поставил руководитель (24.09.2026): снять её сам агент не может,
        // поэтому кнопки нет, но видно, кто, до какого момента и почему.
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            {profile.leadsPausedBy.fullName} остановил вам выдачу новых лидов до{" "}
            {dushanbeDateTime(pausedUntil!.toISOString())}.
            {profile.leadsPausedReason ? ` Причина: ${profile.leadsPausedReason}.` : ""} Текущие клиенты остаются у
            вас. Снять паузу может только руководитель.
          </span>
        </div>
      ) : isPaused ? (
        <div className="mod">
          <div className="t">
            <b>Пауза «не принимаю лиды» включена</b>
            <span>
              Новые лиды вам не назначаются до {dushanbeDateTime(pausedUntil!.toISOString())}. Текущие клиенты
              остаются за вами, KPI считается как обычно.
            </span>
          </div>
          <div className="acts">
            <button className="pill ghost sm" type="button" disabled={resume.isPending} onClick={() => resume.mutate()}>
              Вернуться в распределение
            </button>
          </div>
          <MutationError mutation={resume} fallback="Не удалось снять паузу" />
        </div>
      ) : (
        <div className="mod">
          <div className="t">
            <b>Пауза «не принимаю лиды»</b>
            <span>
              Заболели или заняты: временно не получайте новых клиентов. KPI продолжает считаться, пауза не
              снимает просрочки. Между паузами должно пройти время.
            </span>
          </div>
          <div className="acts">
            <label className="field" style={{ minWidth: 150 }}>
              <span className="lab">На сколько</span>
              <select className="inp" style={{ maxWidth: "none" }} value={hours} onChange={(e) => setHours(e.target.value)}>
                <option value="4">4 часа</option>
                <option value="8">8 часов</option>
                <option value="24">Сутки</option>
                <option value="48">Двое суток</option>
              </select>
            </label>
            <button
              className="pill ghost"
              type="button"
              disabled={pause.isPending}
              onClick={() => pause.mutate(Number(hours))}
            >
              Не принимать лиды
            </button>
          </div>
          <MutationError mutation={pause} fallback="Не удалось включить паузу" />
        </div>
      )}

      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Остановить выдачу лидов может и руководитель. Тогда снять паузу самому нельзя, причина будет написана
          здесь.
        </span>
      </div>
    </section>
  );
}

/**
 * Привязка личного Telegram-чата к CRM (01.09.2026, lib/telegramAgentLink.ts).
 * Сейчас единственное применение: приём готового ролика от монтажёра
 * (Настройки → Публикации → «Монтажёр ручной передачи»), но само поле общее, не
 * завязано на роль, строка видна всем. Клиентам через него не пишут.
 *
 * Статус привязки обновляется только по кнопке «Проверить»: useMyProfile кэширует
 * профиль на 5 минут и не перепроверяет по фокусу окна, а сама привязка
 * происходит вне CRM, в Telegram, где мы не можем узнать о ней раньше.
 */
/**
 * «Копии монтажа в Telegram» (22.09.2026) — админ/директор получает копию всего,
 * что уходит монтажёру (исходники, напоминания о зависшем монтаже). Копии
 * приходят в личный чат с ботом, поэтому без привязки Telegram тумблер честно
 * говорит, что доставлять некуда. Один компонент на обе ширины: мобильный
 * профиль рендерит его же.
 */
function MontageCopiesSection() {
  const { data: profile } = useMyProfile();
  const update = useUpdateMontageCopies();
  const on = profile?.montageCopiesTelegram ?? false;
  const linked = profile?.telegramLinked ?? false;

  return (
    <div className="mod">
      <div className="t">
        <b>Копии монтажа в Telegram</b>
        <span>
          {on && !linked
            ? "Включено, но Telegram не привязан — копии доставлять некуда. Привяжите чат ниже."
            : "Копия исходников и напоминаний, которые получает монтажёр. Отвечать на них не нужно — монтажёром вы не становитесь."}
        </span>
      </div>
      <div className="acts">
        <MhToggle
          on={on}
          label="Копии монтажа в Telegram"
          disabled={update.isPending || !profile}
          onToggle={(next) => update.mutate({ montageCopiesTelegram: next })}
        />
      </div>
      <MutationError mutation={update} fallback="Не удалось изменить копии монтажа" />
    </div>
  );
}

/** Мобильная строка того же тумблера — идиома `.sw-toggle` мобильного профиля. */
function MontageCopiesMobileRow() {
  const { data: profile } = useMyProfile();
  const update = useUpdateMontageCopies();
  const on = profile?.montageCopiesTelegram ?? false;
  return (
    <>
      <div className="sw-toggle">
        <span className="t">
          <span className="n" style={{ fontSize: 15 }}>
            Копии монтажа в Telegram
          </span>
        </span>
        <MhToggle
          on={on}
          label="Копии монтажа в Telegram"
          disabled={update.isPending || !profile}
          onToggle={(next) => update.mutate({ montageCopiesTelegram: next })}
        />
      </div>
      {on && !profile?.telegramLinked && (
        <MhQuiet tone="warn">Telegram не привязан — копии доставлять некуда. Привязка — в профиле на компьютере.</MhQuiet>
      )}
      <MutationError mutation={update} fallback="Не удалось изменить копии монтажа" />
    </>
  );
}

function TelegramLinkSection() {
  const { data: profile } = useMyProfile();
  const qc = useQueryClient();
  const createLink = useCreateTelegramLink();
  const unlink = useUnlinkTelegram();
  const [link, setLink] = useState<{ code: string; deepLink: string | null } | null>(null);

  const linked = profile?.telegramLinked ?? false;
  const canModerate = profile?.permissions.includes("properties.moderate") ?? false;
  const canReviewClips = canModerate || profile?.role === "ADMIN" || profile?.role === "DIRECTOR";

  return (
    <>
    <div className="mod">
      <div className="t">
        <b>Личный чат с ботом CRM в Telegram</b>
        <span>
          Для служебных уведомлений от CRM. Клиентам через эту привязку не пишут.
        </span>
        {link && !linked && (
          <span>
            Откройте ссылку в Telegram или отправьте боту сообщение «/start {link.code}», затем нажмите
            «Проверить».
          </span>
        )}
      </div>
      <div className="acts">
        <span className={linked ? "chip ok" : "chip mute"}>{linked ? "Привязан" : "Не привязан"}</span>
        {linked ? (
          <button
            className="pill ghost sm"
            type="button"
            disabled={unlink.isPending}
            // Код одноразовый и уже использован: без сброса ветка «Привязать» не вернётся.
            onClick={() => unlink.mutate(undefined, { onSuccess: () => setLink(null) })}
          >
            Отвязать
          </button>
        ) : link ? (
          <>
            {link.deepLink && (
              <a className="pill ghost sm" href={link.deepLink} target="_blank" rel="noreferrer">
                Открыть в Telegram
              </a>
            )}
            <button className="pill ghost sm" type="button" onClick={() => qc.invalidateQueries({ queryKey: ["me"] })}>
              Проверить
            </button>
          </>
        ) : (
          <button
            className="pill ghost sm"
            type="button"
            disabled={createLink.isPending}
            onClick={() => createLink.mutate(undefined, { onSuccess: (data) => setLink(data) })}
          >
            Привязать
          </button>
        )}
      </div>
      <MutationError mutation={linked ? unlink : createLink} fallback="Не удалось изменить привязку" />
    </div>
    {canModerate && <TelegramModerationToggle linked={linked} enabled={profile?.telegramModeration ?? false} />}
    {canReviewClips && <ClipReviewTelegramToggle linked={linked} enabled={profile?.clipReviewTelegram ?? false} />}
    </>
  );
}

/**
 * «Модерация в Telegram» (22.09.2026): объекты на проверке и досланные фото
 * приходят в личный чат с ботом с кнопками Одобрить / Вернуть / Поправить.
 * Без привязанного чата включать бессмысленно — тумблер заблокирован.
 */
function TelegramModerationToggle({ linked, enabled }: { linked: boolean; enabled: boolean }) {
  const setModeration = useSetTelegramModeration();
  return (
    <div className="mod">
      <div className="t">
        <b id="tg-moderation-label">Модерация в Telegram</b>
        <span>
          {linked
            ? "Объекты на проверке и досланные фото будут приходить в чат с ботом — решать можно прямо там."
            : "Сначала привяжите Telegram выше."}
        </span>
      </div>
      <div className="acts">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="tg-moderation-label"
          className={enabled ? "pill sm" : "pill ghost sm"}
          disabled={!linked || setModeration.isPending}
          onClick={() => setModeration.mutate(!enabled)}
        >
          {enabled ? "Включено" : "Выключено"}
        </button>
      </div>
      <MutationError mutation={setModeration} fallback="Не удалось переключить модерацию" />
    </div>
  );
}

/**
 * «Готовые ролики на проверку в Telegram» (25.09.2026): ролик от монтажёра,
 * принятый и вставший на проверку клипа, приходит в личный чат с ботом видео с
 * кнопками «Одобрить» / «Вернуть монтажёру» — тот же приём, что у
 * TelegramModerationToggle выше, свой тумблер и свой роут.
 */
function ClipReviewTelegramToggle({ linked, enabled }: { linked: boolean; enabled: boolean }) {
  const setClipReview = useSetClipReviewTelegram();
  return (
    <div className="mod">
      <div className="t">
        <b id="clip-review-telegram-label">Готовые ролики на проверку в Telegram</b>
        <span>
          {linked
            ? "Ролик от монтажёра придёт видео с кнопками «Одобрить» / «Вернуть монтажёру»"
            : "Сначала привяжите Telegram выше."}
        </span>
      </div>
      <div className="acts">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="clip-review-telegram-label"
          className={enabled ? "pill sm" : "pill ghost sm"}
          disabled={!linked || setClipReview.isPending}
          onClick={() => setClipReview.mutate(!enabled)}
        >
          {enabled ? "Включено" : "Выключено"}
        </button>
      </div>
      <MutationError mutation={setClipReview} fallback="Не удалось переключить проверку роликов" />
    </div>
  );
}

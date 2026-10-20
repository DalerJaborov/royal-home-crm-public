import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useCan } from "../lib/permissions";
import { useMobileUx } from "../hooks/useMobileUx";
import { CleanSettingsTaskContent, SettingsTabContent } from "../components/settings/SettingsTabContent";
import { isSettingsTabId, SETTINGS_TABS, type SettingsTabId } from "../lib/settingsTabs";
import { SettingsTabs } from "../components/SectionTabs";
import { UiShellRolloutSection } from "../components/settings/UiShellRolloutSection";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanSettingsNavigator } from "../components/clean/CleanSettingsNavigator";
import { CleanSettingsSectionJump } from "../components/clean/CleanSettingsSectionJump";
import { CLEAN_SETTINGS_LABELS, resolveCleanSettingsTask } from "../lib/cleanSettingsTasks";
import { CLink } from "../components/clean/ui";

/**
 * Настройки CRM — семь вкладок вместо одной длинной страницы.
 *
 * Раньше все разделы шли подряд одной простынёй с чипами-якорями: страница
 * грузилась целиком, и чтобы дойти до здоровья системы, нужно было проскроллить
 * агентов, комиссию и промт бота. Теперь видно только выбранную вкладку.
 *
 * Вкладка живёт в адресе (?tab=), поэтому на конкретную настройку можно дать
 * ссылку, а «назад» в браузере возвращает туда, где человек был.
 *
 * ПК: разметка дословно из эталона (docs/pult/theme-2026/screens/settings.html)
 * — `.scr` > `.pg-h` > `.sset` (список вкладок `.sset-nav` слева, содержимое
 * `.sset-body` справа).
 *
 * ТЕЛЕФОН (14.09.2026, макет c99db05f, `renderCrmSettings`): одна и та же
 * функция `Settings()`, своя ветка разметки внутри неё — хуки, запросы и
 * проверка прав общие с ПК, разошлась только JSX-обёртка. Двойник-файл
 * `components/mobile/MobileSettings.tsx` заводился и был удалён в этой же
 * сессии: правило проекта (CLAUDE.md, история Oversight/MobileOversight)
 * запрещает отдельный мобильный файл, который может молча разойтись с
 * десктопом — красные флаги антифрода однажды уже доехали на прод только в
 * версии для ПК. Дальше в файле — MobileSettingsView и разбор того, почему
 * сами семь вкладок ниже списка остаются в `.scr`, а не переодеты в `.mh`.
 */
// «Воронка» жила здесь вкладкой один день и уехала в главное меню (/funnel,
// просьба владельца 16.08.2026): во время рекламы на неё смотрят каждый час, и
// путь через Настройки с подтверждением личности превращал взгляд на цифры в
// ритуал. Старый адрес ?tab=funnel перенаправляется — см. Settings() ниже.
// Вкладки «Бот» и «ИИ» слиты в одну (18.08.2026, просьба владельца — настройки
// ИИ-ассистента разбросаны по CRM, слишком много кнопок): ключи моделей, общий
// промт, способности бота, паузы и чему бот научился теперь на одном экране.
// Старый адрес ?tab=ai уводил в отдельную вкладку — перенаправляется на bot же.
export function Settings() {
  const agent = useAuthStore((s) => s.agent);
  const can = useCan();
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const clean = useCleanShell();
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  // На телефоне отсутствие ?tab= значит «список разделов» (push-меню макета),
  // на ПК — вкладку «Агентство» по умолчанию: там список слева виден всегда,
  // и пустое содержимое справа было бы просто дырой.
  const active = isSettingsTabId(raw) ? raw : mobile || clean ? null : "agency";
  const task = active && clean ? resolveCleanSettingsTask(active, searchParams, agent?.role) : undefined;

  // Старая ссылка на вкладку воронки ведёт в её новый дом, а не на «Агентство»:
  // адрес мог остаться в закладках и в переписке за день её жизни здесь.
  if (raw === "funnel") return <Navigate to="/funnel" replace />;
  // Старая отдельная вкладка «ИИ» слита в «ИИ-ассистент» (18.08.2026) — ссылка
  // могла остаться в закладках.
  if (raw === "ai") return <Navigate to="/settings?tab=bot" replace />;

  if (!can("settings.view")) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Настройки</h1>
              <p className="sub">Раздел доступен только директору и администратору.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mobile && !clean) {
    return (
      <MobileSettingsView
        active={active}
        agentRole={agent?.role}
        onOpen={(id) => setSearchParams({ tab: id }, { replace: true })}
        onBack={() => setSearchParams({}, { replace: true })}
        onProfile={() => navigate("/profile")}
      />
    );
  }

  const tabContent = <SettingsTabContent tab={active ?? "agency"} agentRole={agent?.role} />;

  if (clean) {
    return (
      <div className="rh2 screens clean-settings-page">
        <div className="scr space-y-5">
          <div className="clean-settings-heading flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-[28px] font-semibold tracking-tight text-ink">Настройки CRM</h1>
            </div>
            <CLink to="/profile" variant="soft">Мой профиль</CLink>
          </div>
          <SettingsTabs />
            <CleanSettingsNavigator active={active} task={task} role={agent?.role} search={searchParams.toString()} />
            {active && task && (
              <section className="sset-body mt-5" aria-label={`Параметры: ${CLEAN_SETTINGS_LABELS[active]}`}>
                <div className="clean-settings-task-heading"><h2>{task.title}</h2><p>{task.hint}</p></div>
                <CleanSettingsSectionJump panelKey={`${active}/${task.id}`} target={searchParams.get("section")} />
                <CleanSettingsTaskContent key={`${active}/${task.id}`} task={task} agentRole={agent?.role} />
              </section>
            )}
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Настройки CRM</h1>
            <p className="sub">Комиссия, лиды, каналы, бот, данные. Меняет только директор и администратор.</p>
          </div>
          {/* Мостик в личный профиль: тема, вход по отпечатку, 2FA и личные
              данные живут там, не здесь. В эталоне — кнопка в шапке экрана. */}
          <div className="acts">
            <button className="pill ghost" type="button" onClick={() => navigate("/profile")}>
              Мой профиль
            </button>
          </div>
        </div>

        <SettingsTabs />

          <div className="sset">
            <nav className="sset-nav" aria-label="Разделы настроек">
              {SETTINGS_TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === active;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-selected={isActive}
                    aria-current={isActive ? "page" : undefined}
                    // replace: переключение вкладок не должно засорять историю —
                    // «назад» обязана уводить из Настроек, а не листать их по одной.
                    onClick={() => setSearchParams({ tab: tab.id }, { replace: true })}
                  >
                    <Icon className="i lg" aria-hidden="true" />
                    <span className="t">
                      <b>{tab.label}</b>
                      <span>{tab.hint}</span>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="sset-body">{active === "agency" && <UiShellRolloutSection />}{tabContent}</div>
          </div>
      </div>
    </div>
  );
}

// Оболочка `.mh` держит содержимое сама (`position:absolute;inset:0`), а
// AppLayout даёт странице поля `px-5 pt-4` и запас снизу под нижнюю панель —
// та же компенсация, что в components/home/mh/MhScreen.tsx,
// pages/TeamMemberDetail.tsx и components/mobile/mh/MhList.tsx. Копия
// значений, а не импорт: те файлы правятся отдельными задачами, а константа —
// четыре строки чистого CSS одной и той же оболочки, не стоит того, чтобы
// связывать их друг с другом.
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};

/**
 * ТЕЛЕФОН. Источник: `renderCrmSettings` в docs/pult/theme-2026/
 * artifact-c99db05f-mobile-nav-14-09.html (~строка 1754) — push-экран
 * `.rh2 .mh`: шапка `.top` со стрелкой назад, тело `.body` со строками
 * `.sw-toggle`/`.grp`. В МАКЕТЕ «Настройки CRM» — это три переключателя,
 * потому что макет показывает один частный пример, а не всё дерево настроек.
 * В реальном коде это семь вкладок с десятками разделов (формы агентства,
 * таблица сотрудников, конструктор промта бота на 3200+ строк и т.д.) —
 * терять их нельзя (просьба владельца 14.09.2026 была про «дизайн макета»,
 * а не про «состав макета»).
 *
 * ДВЕ СТУПЕНИ PUSH, А НЕ АККОРДЕОН. Список разделов (эта функция ниже,
 * `active === null`) — дословно макет: `.card-s` + `.row` с шевроном на
 * каждую вкладку, тот же приём, что и любой список-меню в макете. Открытая
 * вкладка (`active !== null`, внутри той же `MobileSettingsView`) — вторая ступень push,
 * как сам макет ходит по разделам (главная → «Ещё» → конкретный экран), а не
 * раскрытие всех семи вкладок одна под другой на 375 px: обёрнутые в
 * аккордеон, «Каналы связи» (2450+ строк исходника) и «ИИ-ассистент» (3200+)
 * потеряли бы ориентир, где кончается один раздел и начинается следующий.
 *
 * ПОЧЕМУ САМА ВКЛАДКА ОСТАЁТСЯ `.scr`, А НЕ ПЕРЕОДЕТА В `.mh`-КЛАССЫ МАКЕТА.
 * Проверено по theme-2026-proto.css: `.card`, `.fld`, `.acc`, `.tbl`, `.sw`
 * и другие классы, которыми построены реальные разделы (AgencyTab, MoneyTab,
 * LeadsTab, TeamTab, ChannelsTab, BotTab, SystemTab — десятки форм, таблиц,
 * переключателей и сворачиваемых карточек), определены как `.rh2 .scr .card`
 * и т.п. — им обязателен предок `.scr`. `.mh`-классы того же названия
 * (`.rh2 .mh .card-s`, `.rh2 .mh .row`) — из ДРУГОГО файла
 * (theme-2026-mobile-home.css) и описывают другую разметку тем же именем
 * (та же ловушка перечислена в components/home/mh/MhScreen.tsx: «оба
 * артефакта владельца называют разные вещи одинаково»). Заверни реальные
 * разделы в `.mh` — их классы перестанут совпадать с CSS, и десятки строк
 * настроек молча останутся без стилей. Переписать все семь вкладок под
 * `.mh`-словарь классов — это не перенос дизайна одного экрана, а рисование
 * заново всей CRM: формы, таблицы, аккордеоны, которых в макете попросту нет
 * (макет никогда не показывал ни конструктор промта бота, ни таблицу
 * каналов). Поэтому макет — дословно там, где он реально что-то показывает
 * (список разделов, шапка со стрелкой назад), а открытая вкладка — родная
 * `.scr`-разметка, которая уже сужается на 375 px через медиазапросы
 * theme-2026-proto.css.
 */
function MobileSettingsView({
  active,
  agentRole,
  onOpen,
  onBack,
  onProfile,
}: {
  active: SettingsTabId | null;
  agentRole: string | undefined;
  onOpen: (id: SettingsTabId) => void;
  onBack: () => void;
  onProfile: () => void;
}) {
  if (active) {
    const meta = SETTINGS_TABS.find((t) => t.id === active);
    return (
      <div className="rh2 screens">
        <div className="scr" data-stagger>
          <div className="wrap" style={{ marginBottom: 4 }}>
            {/* Стрелка назад — тот же приём, что ClientDetail.tsx (`.lk mut`),
                кнопкой, а не ссылкой: возврат меняет ?tab=, а не маршрут. */}
            <button
              type="button"
              className="lk mut"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: 0,
                padding: 0,
                cursor: "pointer",
              }}
              onClick={onBack}
            >
              <ChevronLeft className="i" aria-hidden="true" />
              Все разделы
            </button>
          </div>

          <div className="pg-h">
            <div>
              <h1>{meta?.label ?? "Настройки"}</h1>
              {meta && <p className="sub">{meta.hint}</p>}
            </div>
          </div>

            <SettingsTabContent tab={active} agentRole={agentRole} />
        </div>
      </div>
    );
  }

  // Список разделов — дословно макет: push-экран `.rh2 .mh`, шапка `.top`,
  // тело `.body` со списком `.card-s`/`.row` и шевроном (тот же приём, что
  // любой список-меню макета c99db05f).
  // ОБЛАСТЬ `.scr`, А НЕ `.mh` (правка 14.09.2026 по кадру 375 px).
  // Чтение настроек не требует повторного кода. Защищённые действия проверяет
  // сервер; общий GlobalStepUpHost открывает подтверждение по ответу 428.
  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Настройки CRM</h1>
          </div>
          {/* Мостик в личный профиль — тот же, что на ПК: тема, вход по
              отпечатку, 2FA и личные данные живут в Профиле, не здесь. */}
          <div className="acts">
            <button type="button" className="pill ghost" onClick={onProfile}>
              Профиль
            </button>
          </div>
        </div>
        <div className="sec" style={{ marginTop: 6 }}>
            <section className="sec" style={{ marginTop: 6 }}>
              <div className="card tight">
                <div className="list">
                  {SETTINGS_TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <div
                        className="row"
                        key={tab.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpen(tab.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") onOpen(tab.id);
                        }}
                      >
                        <span className="plate soft">
                          <Icon className="i" aria-hidden="true" />
                        </span>
                        <span className="t">
                          <span className="n">{tab.label}</span>
                          <span className="s">{tab.hint}</span>
                        </span>
                        <ChevronRight className="i" aria-hidden="true" style={{ flex: "none", color: "var(--faint)" }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
        </div>
      </div>
    </div>
  );
}

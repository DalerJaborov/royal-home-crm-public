import type { HealthTilesData } from "../components/health/healthTiles";
import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Loader2, MessageCircleWarning, OctagonAlert, TimerReset, XCircle } from "lucide-react";
import { useCan } from "../lib/permissions";
import { SystemHealthSection, StuckConversationsSection, AuditLogSection } from "./settings/SystemTab";
import { api } from "../lib/api";
import { StatTile } from "../components/ui/StatTile";

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
import { SettingsTabs } from "../components/SectionTabs";

/**
 * Плитки «За сутки / За неделю / Разобрано / Диалоги без ответа» — по эталону
 * (`tpl-health`). Данные — те же эндпоинты, что уже стоят в `SystemTab.tsx`
 * (`GET /errors`, `GET /errors/stuck-conversations`), но НЕ через общие
 * компоненты: `SystemHealthSection`/`StuckConversationsSection` делятся с
 * вкладкой Настроек и держат счёт внутри себя, без выхода наружу — тянуть его
 * оттуда значило бы переписывать общий файл ради одного экрана.
 *
 * Отдельного `MobileHealth.tsx` больше нет (13.09.2026): узкую раскладку делают
 * медиазапросы темы «Royal Home 2026» (`theme-2026-proto.css`), а вторая копия
 * разметки только рисковала разойтись с этой — как уже случалось с добавленными
 * только на десктоп функциями (см. правило в CLAUDE.md про Mobile*.tsx).
 */

function useHealthTiles() {
  const [data, setData] = useState<HealthTilesData | null>(null);
  const [stuck, setStuck] = useState<number | null>(null);
  const [stuckWork, setStuckWork] = useState<{ givenUp: number; hanging: number } | null>(null);

  useEffect(() => {
    api<HealthTilesData>("/errors").then(setData).catch(() => setData(null));
    api<{ count: number }>("/errors/stuck-conversations")
      .then((r) => setStuck(r.count))
      .catch(() => setStuck(null));
    // Показатель очереди фоновых заданий (владелец 21.09.2026, п.4 задания) —
    // те же counts, что и на экране «Что не доехало» (pages/StuckWork.tsx),
    // здесь только сумма для плитки.
    api<{ counts: { givenUp: number; hanging: number } }>("/stuck-work")
      .then((r) => setStuckWork(r.counts))
      .catch(() => setStuckWork(null));
  }, []);

  return { data, stuck, stuckWork };
}

/** Ответ живой проверки ключа Gemini (POST /errors/gemini-health-check) —
 *  тот же `IntegrationCheck`, что и суточный крон (lib/integrationHealth.ts). */
interface GeminiHealthResult {
  name: string;
  ok: boolean | null;
  detail?: string;
}

/**
 * «Проверить сейчас» для ключа Gemini (13.09.2026, просьба владельца: суточного
 * тика cron.ts директору недостаточно, ждать до утра ради одной проверки не за
 * чем). Дёргает ТОТ ЖЕ `checkGeminiHealth()`, что и крон, — синхронно и по
 * кнопке, ничего не меняя в самом суточном тике.
 */
function GeminiHealthCheckSection() {
  const [result, setResult] = useState<GeminiHealthResult | null>(null);
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      const r = await api<GeminiHealthResult>("/errors/gemini-health-check", { method: "POST" });
      setResult(r);
    } catch (err) {
      setResult({ name: "Gemini", ok: false, detail: err instanceof Error ? err.message : "Проверка не удалась" });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card tight">
      <div className="wrap" style={{ justifyContent: "space-between" }}>
        <div className="wrap" style={{ gap: 8 }}>
          <span className="ic" style={{ "--c": "var(--aqua)" } as React.CSSProperties}>
            <Activity className="i" aria-hidden />
          </span>
          <b>Ключ Gemini</b>
        </div>
        <button className="pill ghost sm" type="button" onClick={check} disabled={checking}>
          {checking ? (
            <>
              <Loader2 className="i animate-spin" aria-hidden style={{ marginRight: 6 }} />
              Проверяю…
            </>
          ) : (
            "Проверить сейчас"
          )}
        </button>
      </div>
      {result && (
        <div className={result.ok === false ? "quiet crit" : "quiet"} style={{ marginTop: "var(--s2)" }}>
          {result.ok ? (
            <CheckCircle2 className="i" style={{ color: "var(--ok)" }} aria-hidden />
          ) : result.ok === null ? (
            <span className="dot" />
          ) : (
            <XCircle className="i" style={{ color: "var(--crit)" }} aria-hidden />
          )}
          <span className="txt">
            {result.ok ? "Ключ жив" : result.ok === null ? "Не настроен" : "Ключ не отвечает"}
            {result.detail ? ` — ${result.detail}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * «Здоровье системы» — отдельная страница вне Настроек (18.08.2026, просьба
 * владельца: мониторинг никто не видел, потому что путь к нему лежал через
 * Настройки → Система → подтверждение личности, и заглядывали туда редко).
 *
 * Сами карточки не задублированы — те же компоненты, что жили в SystemTab,
 * теперь показываются и здесь, и там: второй экран для того же самого был бы
 * ровно той путаницей, которую разобрали в клиентских срезах 14.08.2026.
 *
 * Аудит бота отсюда ушёл в «Обучение бота» (20.08.2026, просьба владельца):
 * здесь про сбои техники, а он — про то, как бот соблюдает свои правила.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/health.html`: `.scr`,
 * `.pg-h` с подзаголовком, отказ в доступе — `.empty` эталона вместо прежней
 * серой строки. Тело страницы (журнал ошибок и зависшие диалоги) живёт в
 * `pages/settings/SystemTab.tsx` и делится с Настройками, поэтому его разметку
 * этот перенос не трогает — она переедет вместе с Настройками.
 *
 * ОДИН ФАЙЛ НА ОБА ОБЛИКА (сверка мобильного макета c99db05f, 14.09.2026):
 * `MobileHealth.tsx` был точной копией разметки ниже без собственной логики
 * (те же плитки, те же секции) — узкую раскладку уже делают медиазапросы
 * темы, вторая копия компонента только расходилась бы с этой. Удалён,
 * `data-stagger` на корневом `.scr` — атрибут работает только внутри
 * `html[data-mobile-ux]` (index.css), на ПК ничего не меняет.
 *
 * ДВЕ СЕКЦИИ ВМЕСТО ОДНОЙ (та же сверка, экран «health»): макет показывает
 * журнал ошибок (errorLog) и журнал действий (auditLog) как разные разделы
 * одного экрана. Разделы остаются здесь, отдельного маршрута не заводим:
 * `SystemHealthSection`/`StuckConversationsSection` — errorLog,
 * `AuditLogSection` (та же лента, что раньше искали только в Архиве) — auditLog.
 */
export function Health() {
  const can = useCan();
  const allowed = can("auditLog.view");
  // Хук — ДО условного return (правило хуков): у кого нет права, тот ниже
  // увидит только .empty, а сам запрос сервер всё равно отклонит по праву.
  const { data: tiles, stuck, stuckWork } = useHealthTiles();
  // Вкладки раздела «Здоровье системы» (перенос меню 15.09.2026): все три
  // пункта требуют то же право auditLog.view, что и раздел в lib/navigation.ts.
  const healthTabs = [
    { to: "/health", label: "Здоровье", end: true, permission: "auditLog.view" as const },
    { to: "/integrations", label: "Интеграции и каналы", permission: "auditLog.view" as const },
    { to: "/backups", label: "Резервные копии", permission: "auditLog.view" as const },
  ];

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Здоровье системы</h1>
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

  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <div className="pg-h">
          <div>
            <h1>Здоровье системы</h1>
            <p className="sub">
              Ошибки, зависшие диалоги без ответа бота и что CRM уже исправила сама — без похода в Настройки.
            </p>
          </div>
        </div>

        <SettingsTabs />

        {/* Тихая строка про зависшие диалоги — то же число, что ниже у
            StuckConversationsSection, честно взятое тем же маршрутом. Строку
            шаблона про «ключ Instagram протухнет через N дней» не переносим:
            в CRM нет проверки срока токена канала — такой даты никто не
            считает, показать было бы нечего, кроме выдумки. */}
        {stuck !== null && stuck > 0 && (
          <div className="card tight">
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                {stuck === 1 ? "Один диалог сегодня остался" : `${stuck} диалогов сегодня остались`} без ответа
                бота. Ответ можно проиграть заново.
              </span>
            </div>
          </div>
        )}

        <div className="tiles">
          <StatTile
            icon={OctagonAlert}
            label="За сутки"
            value={tiles ? tiles.count24h : "…"}
            line="ошибок сервера и браузера"
            critical={!!tiles && tiles.count24h > 0}
            onClick={() => scrollTo("health-error-log")}
            title="Журнал ошибок ниже на этом экране"
          />
          <StatTile
            icon={Activity}
            label="За неделю"
            value={tiles ? tiles.count7d : "…"}
            line="включая уже разобранные"
            onClick={() => scrollTo("health-error-log")}
            title="Журнал ошибок ниже на этом экране"
          />
          <StatTile
            icon={CheckCircle2}
            label="Разобрано"
            value={tiles ? tiles.resolvedCount : "…"}
            line="нажатием «Разобрался»"
            onClick={() => scrollTo("health-error-log")}
            title="Журнал ошибок ниже на этом экране"
          />
          <StatTile
            icon={MessageCircleWarning}
            label="Диалоги без ответа"
            value={stuck ?? "…"}
            line="бот ещё пробует в фоне"
            critical={!!stuck && stuck > 0}
            onClick={() => scrollTo("health-stuck-conversations")}
            title="Список зависших диалогов ниже на этом экране"
          />
          {/* Очередь фоновых заданий (владелец 21.09.2026, п.4 задания) — сдавшиеся
              и зависшие задания BackgroundJob, экран «Что не доехало». */}
          <StatTile
            icon={TimerReset}
            label="Не доехало"
            value={stuckWork ? stuckWork.givenUp + stuckWork.hanging : "…"}
            line={stuckWork ? `сдалось ${stuckWork.givenUp}, висит ${stuckWork.hanging}` : undefined}
            critical={!!stuckWork && stuckWork.givenUp + stuckWork.hanging > 0}
            to="/stuck-work"
            title="Экран «Что не доехало»"
          />
        </div>

        <GeminiHealthCheckSection />
        <div id="health-error-log">
          <SystemHealthSection />
        </div>
        <div id="health-stuck-conversations">
          <StuckConversationsSection />
        </div>
        <AuditLogSection />
      </div>
    </div>
  );
}

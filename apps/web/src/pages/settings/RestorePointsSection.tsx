import { useState } from "react";
import { History, RotateCcw, ShieldAlert } from "lucide-react";
import {
  useRestoreSettings,
  useSettingsRestorePoints,
  type SettingsFieldChange,
  type SettingsRestorePoint,
} from "../../hooks/useSettings";
import { dushanbeDateTime } from "../../lib/date";
import { relativeTime } from "../../lib/format";
import { SettingsSection } from "../../components/settings/SettingsSection";

/**
 * ТОЧКИ ВОЗВРАТА НАСТРОЕК — «вернуть, как было», без кнопки «сбросить всё».
 *
 * Сброса на умолчания здесь нет и не будет: умолчания строки настроек ПУСТЫ —
 * ни маркеров Instagram, ни ключей Gemini, ни паролей АТС, ни промта бота. Такая
 * кнопка чинила бы одну неверную настройку ценой полной остановки каналов связи
 * и телефонии.
 *
 * Точек много, а не одна: испорченное состояние ложится рядом с исправным и
 * ничего не затирает — иначе первое же сохранение поверх поломки сделало бы
 * «вернуть» возвратом к той самой поломке.
 *
 * Разметка — эталон темы «Royal Home 2026» (screens/settings.html, «Точки
 * возврата настроек»): раскрывающийся раздел `.acc`, точки — строки `.mod` с
 * кнопками «Чем отличается» и «Вернуться» в `.acts`.
 */

/** Раздел настройки по имени поля. Полного словаря на 180 полей нет намеренно:
 *  он разъехался бы со схемой на первой же новой настройке и врал бы уверенно.
 *  Область же выводится из имени и остаётся верной сама. */
const FIELD_AREAS: { prefix: string; area: string }[] = [
  { prefix: "meta", area: "Каналы Meta" },
  { prefix: "bot", area: "Бот" },
  { prefix: "asterisk", area: "Телефония" },
  { prefix: "telephony", area: "Телефония" },
  { prefix: "incoming", area: "Входящие звонки" },
  { prefix: "lead", area: "Лиды" },
  { prefix: "property", area: "Объекты" },
  { prefix: "own", area: "Свои объекты" },
  { prefix: "match", area: "Подбор" },
  { prefix: "push", area: "Уведомления" },
  { prefix: "royalScore", area: "Royal Score" },
  { prefix: "kpi", area: "KPI" },
  { prefix: "commission", area: "Деньги" },
  { prefix: "monthly", area: "Деньги" },
  { prefix: "usdToTjs", area: "Деньги" },
  { prefix: "company", area: "Агентство" },
  { prefix: "followUp", area: "Напоминания клиентам" },
  { prefix: "summary", area: "Обязательные окна" },
  { prefix: "waiting", area: "Обязательные окна" },
  { prefix: "inactivity", area: "Дисциплина" },
  { prefix: "seller", area: "Бот" },
  { prefix: "reels", area: "Маркетинг" },
  { prefix: "problemReport", area: "Отчёты" },
  { prefix: "ai", area: "ИИ" },
  { prefix: "anthropic", area: "ИИ" },
  { prefix: "gemini", area: "ИИ" },
  { prefix: "stepUp", area: "Безопасность" },
  { prefix: "handover", area: "Передача портфеля" },
  { prefix: "deal", area: "Сделки" },
  { prefix: "work", area: "Рабочие часы" },
  { prefix: "callback", area: "Обратные звонки" },
  { prefix: "hot", area: "Лиды" },
  { prefix: "refusal", area: "Лиды" },
  { prefix: "sales", area: "Бот" },
  { prefix: "agentPause", area: "Дисциплина" },
  { prefix: "call", area: "Обязательные окна" },
];

function fieldArea(field: string): string {
  return FIELD_AREAS.find((a) => field.startsWith(a.prefix))?.area ?? "Прочее";
}

/** Области, затронутые точкой, — по ним владелец узнаёт нужный момент («тут
 *  трогали Instagram») быстрее, чем по списку из тридцати имён полей. */
export function areasOf(fields: string[]): string[] {
  return [...new Set(fields.map(fieldArea))];
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "пусто";
  if (typeof value === "boolean") return value ? "включено" : "выключено";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "пусто";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChangeRow({ change }: { change: SettingsFieldChange }) {
  return (
    <div className="row">
      <div className="t">
        <b>{change.field}</b>
        <span>
          {fieldArea(change.field)} · было {renderValue(change.from)} → сейчас {renderValue(change.to)}
        </span>
      </div>
    </div>
  );
}

function RestorePointRow({
  point,
  onRestore,
  busy,
}: {
  point: SettingsRestorePoint;
  onRestore: (point: SettingsRestorePoint) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const areas = areasOf(point.changedFields);
  const identical = point.changes.length === 0;

  return (
    <div className="mod">
      <div className="t">
        <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span>
            {dushanbeDateTime(point.createdAt)}, {point.agentName}
          </span>
          {point.reason === "restore" && <span className="chip mute">перед откатом</span>}
          {identical && <span className="chip ok">совпадает с текущими</span>}
        </b>
        <span>
          {relativeTime(point.createdAt)}. Затронуто: {areas.join(", ")}. Полей {point.changedFields.length}.
        </span>
      </div>
      <div className="acts">
        {point.changes.length > 0 && (
          <button className="pill ghost sm" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Скрыть отличия" : `Чем отличается (${point.changes.length})`}
          </button>
        )}
        {/* Возврат — отдельная кнопка, а не текстовая ссылка вровень с «Чем
            отличается»: это необратимое на вид действие, и оно обязано читаться
            как кнопка (см. паттерн восстановления в Archive.tsx). */}
        <button className="pill sm" type="button" onClick={() => onRestore(point)} disabled={busy || identical}>
          <RotateCcw className="i" aria-hidden="true" />
          {busy ? "Возвращаем…" : "Вернуться"}
        </button>
      </div>

      {!point.secretsRestorable && (
        <p className="msg" style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <ShieldAlert className="i" aria-hidden="true" />
          Ключ шифрования сменился с момента этой точки — пароли и маркеры останутся действующими, вернутся
          только остальные настройки.
        </p>
      )}

      {open && (
        <div className="list" style={{ flex: "1 1 100%", maxHeight: 256, overflowY: "auto" }}>
          {point.changes.map((change) => (
            <ChangeRow key={change.field} change={change} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RestorePointsSection() {
  const { data, isLoading, error } = useSettingsRestorePoints();
  const restore = useRestoreSettings();
  const [confirming, setConfirming] = useState<SettingsRestorePoint | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function handleRestore(point: SettingsRestorePoint) {
    setResult(null);
    setFailure(null);
    try {
      const res = await restore.mutateAsync(point.id);
      setResult(
        `Настройки вернулись к состоянию на ${dushanbeDateTime(point.createdAt)}: полей ${res.restoredFields.length}.` +
          (res.skippedSecrets.length
            ? ` Секреты (${res.skippedSecrets.length}) остались действующими — снимок зашифрован другим ключом.`
            : "") +
          (res.skippedStaff?.length
            ? " Сотрудники, которые с тех пор уволены или заморожены, в поля «монтажёр» и «дежурный» не возвращены."
            : "") +
          " Текущее состояние сохранено новой точкой возврата."
      );
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Не удалось вернуть настройки");
    } finally {
      setConfirming(null);
    }
  }

  return (
    <>
      <SettingsSection
        icon={History}
        title="Точки возврата настроек"
        badge={data ? `${data.items.length} точек` : undefined}
      >
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Перед каждым сохранением настроек CRM запоминает, как они выглядели до правки. Если что-то
            настроили неудачно, вернитесь к точке, на которой всё работало, — сбрасывать настройки «на
            заводские» нельзя: заводские здесь ПУСТЫЕ, без ключей, паролей АТС и промта бота. Возврат тоже
            запоминается отдельной точкой, поэтому неудачный откат обратим.
            {data && (
              <>
                {" "}
                Хранится до {data.retention.keepCount} точек и не дольше {data.retention.keepDays} дней.
              </>
            )}
          </span>
        </div>

        {isLoading && (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Загружаем точки возврата
          </div>
        )}
        {error && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">
              Не удалось загрузить точки возврата. Пустой список ниже не означает, что их нет.
            </span>
          </div>
        )}
        {failure && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">{failure}</span>
          </div>
        )}
        {result && (
          <div className="quiet" role="status">
            <span className="dot ok" />
            <span className="txt">{result}</span>
          </div>
        )}

        {data && data.items.length === 0 && (
          <div className="state">Точек пока нет — первая появится при следующем изменении настроек.</div>
        )}

        {data &&
          data.items.length > 0 &&
          data.items.map((point) => (
            <RestorePointRow
              key={point.id}
              point={point}
              busy={restore.isPending && confirming?.id === point.id}
              onRestore={setConfirming}
            />
          ))}
      </SettingsSection>

      {/* Подтверждение обязано говорить, ЧТО именно произойдёт: сколько настроек
          изменится, тронутся ли секреты и что текущее состояние не потеряется.
          Окно рисуется здесь же, внутри области темы `.rh2` — не порталом в body,
          иначе классы макета к нему не применились бы. */}
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-confirm-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "var(--overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--s4)",
          }}
        >
          <div className="card" style={{ width: "100%", maxWidth: 460 }}>
            <div className="sec-h stack">
              <h2 id="restore-confirm-title">Вернуть настройки к {dushanbeDateTime(confirming.createdAt)}?</h2>
            </div>
            <div className="quiet">
              <span className="dot" />
              <span className="txt">Изменится настроек: {confirming.changes.length}.</span>
            </div>
            <div className="quiet">
              <span className="dot" />
              <span className="txt">Разделы: {areasOf(confirming.changes.map((c) => c.field)).join(", ")}.</span>
            </div>
            <div className={`quiet${confirming.secretsRestorable ? "" : " warn"}`}>
              <span className={`dot${confirming.secretsRestorable ? "" : " warn"}`} />
              <span className="txt">
                {confirming.secretsRestorable
                  ? "Ключи и пароли вернутся к значениям того момента и продолжат работать."
                  : "Ключи и пароли НЕ изменятся: снимок зашифрован другим ключом."}
              </span>
            </div>
            <div className="quiet">
              <span className="dot" />
              <span className="txt">
                Текущее состояние сохранится новой точкой — этот возврат можно будет отменить.
              </span>
            </div>
            <div className="quiet">
              <span className="dot" />
              <span className="txt">
                Подключённые аккаунты мессенджеров, логотип и звуки телефонии не затрагиваются — это отдельные
                записи, а не настройки.
              </span>
            </div>
            <div className="wrap" style={{ marginTop: "var(--s4)" }}>
              <button className="pill ghost" type="button" onClick={() => setConfirming(null)}>
                Отмена
              </button>
              <button
                className="pill"
                type="button"
                onClick={() => void handleRestore(confirming)}
                disabled={restore.isPending}
              >
                {restore.isPending ? "Возвращаем…" : "Вернуться"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

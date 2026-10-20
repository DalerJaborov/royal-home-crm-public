import { useState } from "react";

/** Редактор секретного ключа: показывает маску, принимает новое значение,
 *  умеет очистить. Используется и во вкладке «Бот» (ключи ИИ), и в «Каналах связи».
 *
 *  Разметка — дословно эталон темы «Royal Home 2026»
 *  (docs/pult/theme-2026/screens/settings-bot.html, блок «Ключи моделей»):
 *  строка `.key-row` с названием, маской `.msk` и кнопкой «Изменить»/«Задать»;
 *  само поле раскрывается по кнопке — значение ключа не висит на экране всё
 *  время, как и в макете. */
export function SecretKeyEditor({
  title,
  description,
  placeholder,
  configured,
  masked,
  source,
  onSave,
  onClear,
}: {
  title: string;
  description: string;
  placeholder: string;
  configured: boolean | undefined;
  masked: string | null | undefined;
  source: string | null | undefined;
  onSave: (key: string) => Promise<unknown>;
  onClear: () => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      await onSave(key);
      setKey("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить ключ");
    } finally {
      setSaving(false);
    }
  }

  /* «Не настроен» — УТВЕРЖДЕНИЕ, и врать им особенно дорого (аудит
     22.08.2026, раунд 6): владелец, увидев «не задан» на рабочем ключе,
     идёт в Google или Meta и ПЕРЕВЫПУСКАЕТ ключ — тем самым ломая тот, что
     сейчас работает на проде. `configured` приходит как boolean | undefined,
     и `undefined` (настройки ещё не загрузились или запрос упал) раньше
     проваливался в ветку «Не настроен». Теперь у незнания свой вид. */
  const state =
    configured === undefined
      ? "Проверяем, задан ли ключ."
      : configured
        ? `Задан, ${source === "settings" ? "из настроек CRM" : "из файла настроек на сервере"}.`
        : "Не задан.";
  const mask = configured === undefined ? "проверяем" : configured ? (masked ?? "задан") : "не задан";

  return (
    <div>
      <div className="key-row">
        <div className="t">
          <b>{title}</b>
          <span style={{ whiteSpace: "normal" }}>
            {state} {description}
          </span>
        </div>
        <span className="msk">{mask}</span>
        <button
          className={configured ? "pill ghost sm" : "pill sm"}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Свернуть" : configured ? "Изменить" : "Задать"}
        </button>
      </div>

      {open && (
        <form onSubmit={handleSave} className="fld" style={{ marginTop: "var(--s3)" }}>
          <span className="lab">Новое значение</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={placeholder}
            aria-label={`${title}: новое значение`}
          />
          <span className="msg">После сохранения показываются только последние знаки.</span>
          <div className="wrap" style={{ marginTop: "var(--s2)" }}>
            <button className="pill" type="submit" disabled={saving || !key}>
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
            {source === "settings" && (
              <button className="pill ghost" type="button" onClick={() => onClear().catch(() => {})}>
                Очистить
              </button>
            )}
            {success && <span className="saved on">Ключ сохранён</span>}
          </div>
          {error && (
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

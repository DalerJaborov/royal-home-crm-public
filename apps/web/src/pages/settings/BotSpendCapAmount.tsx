import { useEffect, useState } from "react";
import { BOT_DAILY_SPEND_CAP_DEFAULT_USD, BOT_DAILY_SPEND_CAP_MAX_USD } from "@royal-home/shared";
import { useUpdateSettings } from "../../hooks/useSettings";

/**
 * СУММА СУТОЧНОГО ПОТОЛКА ТРАТ БОТА КЛИЕНТОВ (CRM-47, 26.11.2026) — строка под рубильником «Бот клиентов: суточный
 * потолок трат на ИИ» в «Автоматике ИИ». Пустое поле не сохраняется как 0: Number("") снял бы потолок молча.
 * Разметка — та же, что у «Потолка минут робота» (BotTab.tsx::LiveVoiceSpendCapFields): один экран на ПК и телефон.
 */
/** `stored` — значение из уже загруженных настроек родителя (AutomationSwitchesSection): свой запрос здесь не нужен. */
export function BotSpendCapAmount({ stored }: { stored: number | undefined }) {
  const updateSettings = useUpdateSettings();
  const [value, setValue] = useState(String(BOT_DAILY_SPEND_CAP_DEFAULT_USD));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (stored !== undefined) setValue(String(stored));
  }, [stored]);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setSaved(false);
        if (value.trim() === "") {
          setError("Впишите сумму в долларах (0 — без потолка)");
          return;
        }
        try {
          await updateSettings.mutateAsync({ botDailySpendCapUsd: Number(value) });
          setSaved(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Не удалось сохранить");
        }
      }}
    >
      <div className="mod">
        <div className="t">
          <b>Потолок трат бота</b>
          <span style={{ whiteSpace: "normal" }}>Сколько долларов бот клиентов может потратить на ИИ за сутки. 0 — без потолка.</span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={0}
              max={BOT_DAILY_SPEND_CAP_MAX_USD}
              step="0.5"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Потолок трат бота в долларах за сутки"
            />
            <span className="u">$ в сутки</span>
          </span>
          <button className="pill sm" type="submit" disabled={updateSettings.isPending}>
            Сохранить
          </button>
        </div>
      </div>
      <div className="wrap">
        {saved && <span className="saved on">Сохранено</span>}
        {error && <span className="msg" role="alert" style={{ color: "var(--crit)" }}>{error}</span>}
      </div>
    </form>
  );
}

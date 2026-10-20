import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { api } from "../lib/api";

interface DistillResult {
  processed: number;
  learned: number;
  limited: boolean;
}

/**
 * «Разобрать сейчас» — не ждать до двух часов, пока крон сам доберётся до
 * очереди накопленных случаев (19.08.2026, просьба владельца). Разбирает саму
 * очередь: диалоги, где вместо бота ответил сотрудник или клиент не понял, —
 * те же случаи, что копятся сами в реальном времени. Это не «перечитать всю
 * историю переписок с нуля»: учиться можно только там, где уже виден явный
 * сигнал ошибки.
 *
 * Живёт отдельным компонентом (`pages/AiLearning.tsx` — один экран на обе
 * ширины с 10.09.2026, отдельной мобильной копии больше нет).
 *
 * ОБЛИК — тема «Royal Home 2026», эталон tpl-ai-learning: кнопка
 * стоит в шапке экрана (`.pg-h .acts`) как `.pill.ghost`, ответ сервера —
 * тихой строкой `.quiet`, а не всплывающей карточкой.
 */
export function DistillNowButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DistillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<DistillResult>("/bot-learning/distill-now", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось запустить разбор");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, minWidth: 0 }}>
      <button className="pill ghost" type="button" onClick={run} disabled={busy}>
        <Sparkles className="i" aria-hidden />
        {busy ? "Разбираю…" : "Разобрать сейчас"}
      </button>

      {(result || error) && (
        <div className="card tight" style={{ maxWidth: 340 }}>
          {error && (
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          )}
          {result && (
            <div className={`quiet${result.learned > 0 ? "" : " warn"}`}>
              <span className={`dot ${result.learned > 0 ? "ok" : "warn"}`} />
              <span className="txt">
                Разобрано случаев: <b>{result.processed}</b>. Выведено правил: <b>{result.learned}</b>.
              </span>
            </div>
          )}
          {result?.limited && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Очередь больше потолка за один запуск, нажмите ещё раз, чтобы разобрать остаток.
              </span>
            </div>
          )}
          <button
            className="lnk"
            type="button"
            aria-label="Скрыть результат разбора"
            onClick={() => {
              setResult(null);
              setError(null);
            }}
          >
            <X className="i" aria-hidden /> Понятно
          </button>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import {
  useConfirmPendingRate,
  useDismissPendingRate,
  useExchangeRateStatus,
  useRefreshRateCaptions,
  useResyncSitePrices,
  useSetRateAlertPct,
} from "../../hooks/useExchangeRateWatch";

const CHANNEL_NAMES: Record<string, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  FACEBOOK: "Facebook",
  TELEGRAM: "Telegram",
  YOUTUBE: "YouTube",
  THREADS: "Threads",
};

function pct(value: number | null): string {
  if (value === null) return "";
  const r = Math.round(value * 10) / 10;
  return `${r > 0 ? "+" : ""}${String(r).replace(".", ",")} %`;
}

function comma(value: number | string | null): string {
  return value === null ? "—" : String(value).replace(".", ",");
}

/**
 * «Состояние курса» (владелец 28.11.2026): работает ли обновление, что ждёт подтверждения и что с ценами на сайте и в соцсетях.
 * Подписи в соцсетях сами не переписываются — только кнопкой «Обновить подписи».
 */
export function ExchangeRateWatchPanel() {
  const { data: st, isError } = useExchangeRateStatus();
  const confirm = useConfirmPendingRate();
  const dismiss = useDismissPendingRate();
  const resync = useResyncSitePrices();
  const captions = useRefreshRateCaptions();
  const setPct = useSetRateAlertPct();
  const [alertPct, setAlertPct] = useState("");
  const [askCaptions, setAskCaptions] = useState(false);
  if (isError) {
    return <p className="quiet crit" role="alert">Не удалось проверить состояние курса. Обновите страницу.</p>;
  }
  if (!st) return null;

  const stale = st.staleCaptions;
  const result = captions.data;
  const pctValue = Number(alertPct);

  return (
    <div style={{ marginTop: "var(--s4)", display: "grid", gap: "var(--s3)" }} data-testid="rate-watch">
      <div className={`quiet ${st.stale ? "crit" : ""}`} role={st.stale ? "alert" : undefined}>
        <span className={`dot ${st.stale ? "crit" : "ok"}`} />
        <span className="txt">
          {st.stale
            ? st.ageHours === null
              ? "Курс ещё ни разу не обновлялся. Задайте его вручную или нажмите «Обновить с alif.tj»."
              : `Курс не обновлялся ${st.ageHours} ч (больше ${st.staleAfterHours} ч). Директору и админу ушло сообщение. Нажмите «Обновить с alif.tj» или задайте курс вручную.`
            : `Обновление работает: курс свежий${st.ageHours !== null ? ` (${st.ageHours} ч назад)` : ""}. Если не обновится больше ${st.staleAfterHours} ч, придёт сообщение директору и админу.`}
        </span>
      </div>

      {st.pending && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">
            alif.tj отдаёт {comma(st.pending.rate)} вместо {comma(st.rate)} ({pct(st.pending.changePct)}). Скачок больше {st.jumpLimitPct} %, поэтому я его не применил. Если курс настоящий, подтвердите.
          </span>
          <span className="wrap" style={{ gap: 8, marginLeft: 8 }}>
            <button className="pill sm" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              Принять новый курс
            </button>
            <button className="pill ghost sm" type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
              Оставить прежний
            </button>
          </span>
        </div>
      )}

      {(confirm.isError || dismiss.isError) && (
        <p className="quiet crit" role="alert">
          {((confirm.error ?? dismiss.error) as Error | null)?.message ?? "Не удалось выполнить"}
        </p>
      )}

      <div className="mod">
        <div className="t">
          <b>Цены на сайте</b>
          <span>
            {st.siteResyncEnabled
              ? `При смене курса больше ${comma(st.alertPct)} % цены ${st.siteUsdCount} объектов в долларах на сайте пересчитываются сами.`
              : "Автопересчёт выключен (Настройки → Автоматика). Пересчитать можно кнопкой."}
          </span>
        </div>
        <div className="acts">
          <button className="pill ghost sm" type="button" disabled={resync.isPending || st.siteUsdCount === 0} onClick={() => resync.mutate()}>
            Пересчитать цены на сайте
          </button>
        </div>
      </div>
      {resync.isSuccess && <p className="quiet" role="status">Поставлено на пересчёт: {resync.data.count}. Сайт обновится в течение нескольких минут.</p>}
      {resync.isError && <p className="quiet crit" role="alert">{resync.error instanceof Error ? resync.error.message : "Не удалось"}</p>}

      <div className="mod">
        <div className="t">
          <b>Подписи в соцсетях</b>
          <span>
            {stale.length === 0
              ? "У всех объектов в долларах цена в подписи совпадает с текущим курсом."
              : `У ${stale.length} ${stale.length === 1 ? "объекта" : "объектов"} подпись со старой ценой: ${stale.slice(0, 8).map((c) => c.code).join(", ")}${stale.length > 8 ? "…" : ""}. Сами подписи не меняются, только по кнопке.`}
          </span>
        </div>
        <div className="acts">
          {!askCaptions ? (
            <button className="pill ghost sm" type="button" disabled={stale.length === 0} onClick={() => setAskCaptions(true)}>
              Обновить подписи
            </button>
          ) : (
            <>
              <span className="quiet">
                Поправлю живые посты в Telegram, Facebook, YouTube. Instagram и TikTok — руками. Обновить {Math.min(stale.length, 40)}?
              </span>
              <button
                className="pill sm"
                type="button"
                disabled={captions.isPending}
                onClick={() => {
                  captions.mutate();
                  setAskCaptions(false);
                }}
              >
                Да, обновить
              </button>
              <button className="pill ghost sm" type="button" onClick={() => setAskCaptions(false)}>
                Отмена
              </button>
            </>
          )}
        </div>
      </div>
      {captions.isPending && <p className="quiet" role="status">Ставлю подписи в очередь…</p>}
      {result && (
        <div className="quiet" role="status">
          <span className="txt">
            Поставлено на отправку: {result.queued}.{result.skipped > 0 ? ` Пропущено: ${result.skipped}.` : ""}
            {result.remaining > 0 ? ` Ещё ${result.remaining}: нажмите ещё раз.` : ""}
            {result.manual.length > 0
              ? ` Руками поправить цену: ${result.manual.map((m) => `${m.code} (${m.channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ")})`).join("; ")}.`
              : ""}
          </span>
        </div>
      )}
      {captions.isError && <p className="quiet crit" role="alert">{captions.error instanceof Error ? captions.error.message : "Не удалось обновить подписи"}</p>}

      <div className="mod">
        <div className="t">
          <b>Порог срабатывания</b>
          <span>Курс сдвинулся больше чем на столько процентов: пересчитать сайт и предупредить про подписи.</span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="20"
              value={alertPct === "" ? String(st.alertPct) : alertPct}
              onChange={(e) => setAlertPct(e.target.value)}
              aria-label="Порог изменения курса, проценты"
            />
            <span className="u">%</span>
          </span>
          <button
            className="pill ghost sm"
            type="button"
            disabled={setPct.isPending || alertPct === "" || !(pctValue >= 0.1 && pctValue <= 20)}
            onClick={() => setPct.mutate(pctValue, { onSuccess: () => setAlertPct("") })}
          >
            Сохранить порог
          </button>
        </div>
      </div>
    </div>
  );
}

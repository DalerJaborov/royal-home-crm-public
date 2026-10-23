import { Megaphone } from "lucide-react";
import { REELS_AUTOBOOST_CTA_TYPES, type ReelsAutoBoostCtaType, type ReelsAutoBoostStatus } from "@royal-home/shared";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { SwitchRow } from "../../components/Switch";
import { useCanWriteAds } from "../../hooks/useAds";
import { useReelsAutoBoost, useRunReelsAutoBoost, useUpdateReelsAutoBoost } from "../../hooks/useReelsAutoBoost";
import { dushanbeDate, dushanbeTime } from "../../lib/date";
import { useCan } from "../../lib/permissions";
import { useAuthStore } from "../../store/auth";

/**
 * АВТОПРОДВИЖЕНИЕ РОЛИКОВ (23.10.2026, api: lib/ads/reelsAutoBoost.ts).
 *
 * Каждый новый ролик объекта, вышедший в Instagram, CRM сама превращает в объявление
 * ОДНОЙ постоянной кампании Meta и сама ставит лишнее на паузу. Выключено по
 * умолчанию, пробный режим включён: решения считаются и видны в таблице ниже, а в
 * Meta не уходит ничего. Боевой режим требует оплаченный кабинет, маркер с правом
 * ads_management и номер группы объявлений кампании из Ads Manager.
 */

const CTA_LABELS: Record<ReelsAutoBoostCtaType, string> = {
  WHATSAPP_MESSAGE: "Написать в WhatsApp",
  INSTAGRAM_DIRECT: "Написать в Instagram Direct",
  MESSENGER: "Написать в Messenger",
};

const STATUS_VIEW: Record<ReelsAutoBoostStatus, { label: string; tone: string }> = {
  PLANNED: { label: "Запланировано", tone: "chip" },
  ACTIVE: { label: "Продвигается", tone: "chip ok" },
  PAUSED: { label: "Пауза", tone: "chip mute" },
  FAILED: { label: "Ошибка", tone: "chip crit" },
  SKIPPED: { label: "Пропущен", tone: "chip warn" },
};

export function ReelsAutoBoostSection() {
  const canWrite = useCanWriteAds();
  // Читать могут те же, кто видит остальную рекламу (api: requireAdsRead) — остальным запрос не шлём вовсе.
  const can = useCan();
  const role = useAuthStore((st) => st.agent?.role);
  const canRead = role === "MARKETING" || can("finance.view");
  const { data } = useReelsAutoBoost(canRead);
  const update = useUpdateReelsAutoBoost();
  const run = useRunReelsAutoBoost();
  const s = data?.settings;
  const busy = update.isPending || run.isPending;

  if (!canRead || !data || !s) return null;

  const badge = !s.enabled ? "выключено" : s.dryRun ? "пробный режим" : `${data.counts.ACTIVE} в рекламе`;
  const error = update.error ?? run.error;

  return (
    <SettingsSection icon={Megaphone} title="Автопродвижение роликов" badge={badge}>
      <SwitchRow
        title="Автопродвижение роликов"
        on={s.enabled}
        disabled={!canWrite || busy}
        hint={
          s.enabled
            ? `Раз в 30 минут CRM проверяет новые ролики в Instagram${s.dryRun ? " и только записывает, что сделала бы" : " и сама создаёт и останавливает объявления"}.`
            : "Ничего не проверяется и не создаётся."
        }
        onToggle={() => update.mutate({ enabled: !s.enabled })}
      />
      <SwitchRow
        title="Пробный режим"
        on={s.dryRun}
        disabled={!canWrite || busy}
        hint={
          s.dryRun
            ? "В Meta не уходит ничего: решения только пишутся в таблицу ниже."
            : "Боевой режим: объявления создаются и останавливаются в рекламном кабинете, деньги тратятся."
        }
        warning={
          !s.dryRun ? "Нужны оплаченный кабинет, маркер рекламы с правом ads_management и номер группы объявлений." : null
        }
        onToggle={() => update.mutate({ dryRun: !s.dryRun })}
      />

      <div className="mod">
        <div className="t">
          <b>Группа объявлений постоянной кампании</b>
          <span style={{ whiteSpace: "normal" }}>
            Создаётся один раз в Ads Manager (цель «Сообщения», бессрочно). Номер — только цифры.
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="text"
              inputMode="numeric"
              aria-label="Номер группы объявлений"
              placeholder="120000000000000"
              defaultValue={s.adSetId ?? ""}
              key={s.adSetId ?? "empty"}
              disabled={!canWrite || busy}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (s.adSetId ?? "")) update.mutate({ adSetId: v === "" ? null : v });
              }}
            />
          </span>
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Кнопка объявления</b>
          <span>Куда ведёт человека, который нажал на рекламу.</span>
        </div>
        <div className="acts">
          <select
            className="inp"
            style={{ maxWidth: 240 }}
            aria-label="Кнопка объявления"
            value={s.ctaType}
            disabled={!canWrite || busy}
            onChange={(e) => update.mutate({ ctaType: e.target.value as ReelsAutoBoostCtaType })}
          >
            {REELS_AUTOBOOST_CTA_TYPES.map((t) => (
              <option key={t} value={t}>
                {CTA_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Лимиты</b>
          <span style={{ whiteSpace: "normal" }}>
            Сколько роликов в рекламе одновременно, сколько дней ролик продвигается после выхода и сколько можно
            потратить на ролик без единой переписки (в валюте кабинета, у нас — доллары), прежде чем он встанет на паузу.
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={1}
              max={200}
              inputMode="numeric"
              aria-label="Роликов одновременно"
              defaultValue={s.maxActive}
              key={`a${s.maxActive}`}
              disabled={!canWrite || busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 200 && n !== s.maxActive) update.mutate({ maxActive: n });
              }}
            />
            <span className="u">одновременно</span>
          </span>
          <span className="nf">
            <input
              type="number"
              min={1}
              max={60}
              inputMode="numeric"
              aria-label="Дней продвижения"
              defaultValue={s.maxAgeDays}
              key={`d${s.maxAgeDays}`}
              disabled={!canWrite || busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 60 && n !== s.maxAgeDays) update.mutate({ maxAgeDays: n });
              }}
            />
            <span className="u">дней</span>
          </span>
          <span className="nf">
            <input
              type="number"
              min={0}
              max={1000}
              step="0.5"
              inputMode="decimal"
              aria-label="Стоп-лосс, расход без переписок"
              defaultValue={s.stopLossSpendUsd}
              key={`s${s.stopLossSpendUsd}`}
              disabled={!canWrite || busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0 && n <= 1000 && n !== s.stopLossSpendUsd) {
                  update.mutate({ stopLossSpendUsd: n });
                }
              }}
            />
            <span className="u">стоп-лосс</span>
          </span>
        </div>
      </div>

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error instanceof Error ? error.message : "Не удалось сохранить"}</span>
        </div>
      )}
      {run.data && (
        <div className="quiet" role="status">
          <span className="txt">
            {run.data.result.ran
              ? `Проверка сделана: новых ${run.data.result.created}, на паузу ${run.data.result.paused}, без изменений ${run.data.result.kept}, ошибок ${run.data.result.failed}.`
              : `Проверка не выполнялась: ${run.data.result.note ?? "причина неизвестна"}.`}
          </span>
        </div>
      )}

      <div className="wrap" style={{ marginTop: "var(--s3)" }}>
        <button className="pill ghost sm" type="button" disabled={!canWrite || busy || !s.enabled} onClick={() => run.mutate()}>
          {run.isPending ? "Проверяю…" : "Проверить сейчас"}
        </button>
        <span className="saved">
          Запланировано {data.counts.PLANNED}, в рекламе {data.counts.ACTIVE}, на паузе {data.counts.PAUSED}, ошибок{" "}
          {data.counts.FAILED}.
        </span>
      </div>

      {data.rows.length === 0 ? (
        <div className="quiet">
          <span className="txt">Решений пока нет. Они появятся, когда включите автопродвижение и выйдет ролик.</span>
        </div>
      ) : (
        <div className="list" style={{ marginTop: "var(--s3)" }}>
          {data.rows.map((r) => {
            const view = STATUS_VIEW[r.status];
            return (
              <div className="row" key={r.id}>
                <div className="t">
                  <b>
                    {r.propertyShortId ? `№${r.propertyShortId} · ` : ""}
                    {r.propertyTitle ?? "Объект"}
                  </b>
                  <span style={{ whiteSpace: "normal" }}>
                    {r.reason}
                    {r.spendUsd !== null && ` · потрачено ${r.spendUsd.toFixed(2)}, переписок ${r.conversations ?? 0}`}
                  </span>
                  <span>
                    {dushanbeDate(r.updatedAt)} {dushanbeTime(r.updatedAt)}
                  </span>
                </div>
                <div className="act">
                  <span className={view.tone}>{view.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

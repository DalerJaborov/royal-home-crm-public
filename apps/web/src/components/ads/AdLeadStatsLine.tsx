import type { AdLeadStats } from "@royal-home/shared";
import { describeLeadStats, LEAD_VS_META_HINT } from "../../lib/adsView";
import { formatMoneyExact } from "../../lib/format";

/**
 * «КЛИЕНТОВ В CRM: N · ЦЕНА КЛИЕНТА X» — реальная цена рядом с «обращением» Meta
 * (волна 1 рекламы, 03.10.2026).
 *
 * «Результат» Meta — переписки по версии Meta; клиент — человек, попавший в CRM с этого
 * объявления (Client.sourceAdId). Цена клиента честнее, но выше, и без подсказки
 * владелец принимал бы её за ошибку: поэтому у строки есть `title`, а на странице — одна
 * видимая фраза (см. `LeadVsMetaNote`).
 *
 * Ноль клиентов при расходе — «клиентов в CRM нет», а не «0 с.»: ноль цены читался бы как
 * «бесплатно». Строка не рисуется, когда сказать нечего (поля нет или нет ни расхода, ни
 * клиентов) — экран выглядит как раньше. Класс `quiet` — идиома эталона, один адаптивный
 * файл без отдельной мобильной копии.
 */
export function AdLeadStatsLine({
  stats,
  spendTjs,
  compact = false,
  funnelOnly = false,
}: {
  stats: AdLeadStats | null | undefined;
  spendTjs: number;
  /** Без подписи про Meta — для плашки, где «за обращение» рядом в соседней плитке. */
  compact?: boolean;
  /** Клиенты и цена уже показаны плитками рядом: строка нужна только для воронки (показы, сделки). */
  funnelOnly?: boolean;
}) {
  const text = describeLeadStats(stats, spendTjs);
  if (!text || !stats) return null;
  if (funnelOnly) {
    if (!text.funnel) return null;
    return (
      <div className="quiet" title={LEAD_VS_META_HINT}>
        <span className="dot ok" aria-hidden />
        <span className="txt">{text.funnel}</span>
      </div>
    );
  }

  return (
    <div className="quiet" title={LEAD_VS_META_HINT}>
      <span className={text.noLeads ? "dot warn" : "dot ok"} aria-hidden />
      <span className="txt">
        {text.primary}
        {!compact && stats.costPerLeadMeta != null && (
          <> · обращение по Meta {formatMoneyExact(stats.costPerLeadMeta, "TJS")}</>
        )}
        {text.funnel && <> · {text.funnel}</>}
      </span>
    </div>
  );
}

/** Одна видимая фраза на странице: чем клиент отличается от обращения (на телефоне `title` не виден). */
export function LeadVsMetaNote() {
  return (
    <div className="quiet" style={{ marginTop: 12 }}>
      <span className="dot" aria-hidden />
      <span className="txt">{LEAD_VS_META_HINT}</span>
    </div>
  );
}

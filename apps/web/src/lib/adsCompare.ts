import type { AdPeriodPreset } from "./adsView";

/**
 * ПРОШЛЫЙ ПЕРИОД ДЛЯ СРАВНЕНИЯ «РЕКЛАМЫ» (разделы директора, 20.11.2026).
 *
 * Директор спрашивает не «сколько потратили», а «лучше или хуже, чем было».
 * Сервер доски (`GET /ads/board`) уже принимает произвольные даты from/to — здесь
 * только вычисляется отрезок той же длины прямо перед выбранным:
 *  - сегодня → вчера, вчера → позавчера;
 *  - 7 и 30 дней → предыдущие 7 и 30 дней;
 *  - этот месяц (с 1-го по сегодня) → прошлый месяц с 1-го по то же число
 *    (а не весь прошлый месяц: иначе 20 дней сравнивались бы с 30);
 *  - прошлый месяц → позапрошлый целиком;
 *  - всё время → сравнивать не с чем (null).
 * Даты — календарные дни по Душанбе ключами «ГГГГ-ММ-ДД», как у сервера.
 */
export function previousAdPeriod(preset: AdPeriodPreset, todayKey: string): { from: string; to: string } | null {
  const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (k: string, days: number) => key(new Date(day(k).getTime() + days * 86_400_000));
  const today = todayKey;
  switch (preset) {
    case "today": {
      const y = shift(today, -1);
      return { from: y, to: y };
    }
    case "yesterday": {
      const y = shift(today, -2);
      return { from: y, to: y };
    }
    case "7d":
      return { from: shift(today, -13), to: shift(today, -7) };
    case "30d":
      return { from: shift(today, -59), to: shift(today, -30) };
    case "month": {
      const t = day(today);
      const from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
      const lastOfPrev = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0)).getUTCDate();
      const to = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, Math.min(t.getUTCDate(), lastOfPrev)));
      return { from: key(from), to: key(to) };
    }
    case "prev_month": {
      const t = day(today);
      return {
        from: key(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 2, 1))),
        to: key(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 0))),
      };
    }
    default:
      return null;
  }
}

/** Чем назван прошлый отрезок в подсказке чипа «▲ 12 %». */
export function previousAdPeriodLabel(preset: AdPeriodPreset): string {
  switch (preset) {
    case "today": return "вчера";
    case "yesterday": return "позавчера";
    case "7d": return "в прошлые 7 дней";
    case "30d": return "в прошлые 30 дней";
    case "month": return "за те же дни прошлого месяца";
    case "prev_month": return "в позапрошлом месяце";
    default: return "раньше";
  }
}

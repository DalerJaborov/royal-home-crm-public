import type { CSSProperties } from "react";
import { ShieldCheck } from "lucide-react";
import type { BotGuardDropShare } from "@royal-home/shared";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { useBotGuardStats } from "../../hooks/useBotGuardStats";

/**
 * «Фильтры ответов бота» — счётчики с удалённого экрана «Обучение бота» (23.11.2026).
 *
 * Зачем остались: по ним видно, какую долю ответов нового помощника отбросила
 * проверка (то же правило, что в дневной строке владельцу — намеренно выключенное
 * в долю не входит) и как часто фильтры чинят реплику бота. Только чтение: ничего
 * здесь не включается и не выключается. Сервер — GET /settings/bot-guard-stats.
 * Запрос уходит, только когда складку раскрыли.
 */
export function BotGuardStatsSection() {
  return (
    <SettingsSection icon={ShieldCheck} title="Фильтры ответов бота" badge="14 дней">
      <BotGuardStatsBody />
    </SettingsSection>
  );
}

/** Одна строка доли отброшенного у нового помощника: сколько, из скольких и что не в счёт. */
function DropShareLine({ title, share, extra }: { title: string; share: BotGuardDropShare; extra?: string }) {
  if (share.total === 0 && share.intentional === 0) {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{title}: за эти дни проверок не было.</span>
      </div>
    );
  }
  // Тот же порог, что у дневной строки владельцу (lib/customerAgentSayStats.ts): от 5 случаев и больше 20%.
  const high = share.total >= 5 && share.sharePercent > 20;
  return (
    <div className={high ? "quiet warn" : "quiet"}>
      <span className={high ? "dot warn" : "dot"} />
      <span className="txt" style={{ whiteSpace: "normal" }}>
        {title}: отброшено {share.sharePercent}% ({share.dropped} из {share.total})
        {extra ? `. ${extra}` : ""}
        {share.intentional > 0 ? `. Не в счёт, выключено намеренно: ${share.intentional}` : ""}.
      </span>
    </div>
  );
}

export function BotGuardStatsBody() {
  const { data, isLoading, isError, refetch } = useBotGuardStats();
  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем счётчики
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="state err" role="alert">
        <span className="dot crit" />
        Счётчики не загрузились — это сбой связи, а не «фильтры молчат».{" "}
        <button className="lk" type="button" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
          Повторить
        </button>
      </div>
    );
  }
  const max = data.filters[0]?.count ?? 0;
  return (
    <>
      <DropShareLine title="Новый помощник, ответ модели" share={data.answer}
        extra={data.answer.factAttempts > 0 ? `Модель сама написала факт: ${data.answer.factAttempts}` : undefined} />
      <DropShareLine title="Новый помощник, живая фраза" share={data.say} />
      {data.filters.length === 0 ? (
        <p className="state">За {data.days} дней ни один фильтр не сработал.</p>
      ) : (
        <div className="bars">
          {data.filters.map((row) => (
            <div className="b" key={row.guard}>
              <span className="nm3" title={row.label}>{row.label}</span>
              <span className="tr"><i style={{ "--v": max > 0 ? row.count / max : 0 } as CSSProperties} /></span>
              <span className="vl">{row.count}</span>
            </div>
          ))}
        </div>
      )}
      <div className="quiet">
        <span className="dot" />
        <span className="txt" style={{ whiteSpace: "normal" }}>
          Каждое срабатывание значит, что ответ ушёл исправленным или заявка не завелась зря.
        </span>
      </div>
    </>
  );
}

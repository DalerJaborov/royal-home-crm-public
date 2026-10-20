import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ExternalLink, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { useAdAccounts, type AdBoardRow, type AdDelivery, type AdsBoard as AdsBoardData } from "../../hooks/useAds";
import { DELIVERY, describeLeadStats, OBJECTIVE_LABEL, shortDate } from "../../lib/adsView";
import { formatMoneyExact } from "../../lib/format";
import { useCanWriteAds } from "../../hooks/useAds";
import { AdMaterialsNote, AdPropertyChips } from "./AdPropertyChips";
import { AdLeadStatsLine, LeadVsMetaNote } from "./AdLeadStatsLine";
import type { AdSheetTarget } from "./AdPropertiesSheet";

/**
 * СПИСОК ОБЪЯВЛЕНИЙ — что рекламируем, идёт ли оно и сколько стоило.
 *
 * Строка отвечает на три вопроса и молчит про остальное: ЧТО рекламируем,
 * ИДЁТ ЛИ (точка и слово), СКОЛЬКО стоило и что принесло. Показы и клики ушли из
 * строки: при цели «переписки» они ничего не решают, а глазами по ним всё равно
 * никто не ходит — они остались в разборе ИИ и во вкладке «по объектам».
 *
 * «ИДЁТ» СЧИТАЕТ СЕРВЕР, а не Meta: у неё завершённое объявление навсегда
 * остаётся ACTIVE (см. api: lib/ads/adDelivery.ts). Здесь только показываем.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/ads.html`: срез — сегмент
 * `.seg`, строка — `.prow` с картинкой `.ph`, названием `.t`, деньгами `.pr`,
 * состоянием `.chip` и отдачей в `.act`. Состояния — `.state` и `.empty`.
 */

/** Что показываем: всё, только идущее, только остановленное. */
type StateFilter = "all" | "running" | "stopped";

/** Точка состояния классами эталона: идёт — ok, включено без трат — warn, иначе серая. */
const DOT: Record<AdDelivery, string> = {
  RUNNING: "dot ok",
  STALLED: "dot warn",
  REVIEW: "dot warn",
  REJECTED: "dot crit",
  FINISHED: "dot",
  PAUSED: "dot",
  NEVER: "dot",
};

/** Что окно «Привязать объекты» должно знать о строке доски. */
export function adTargetFromRow(row: AdBoardRow): AdSheetTarget {
  return {
    id: row.id,
    title: row.headline || row.campaignName || row.name,
    assetCount: row.assetCount ?? null,
    properties: row.properties ?? [],
  };
}

export function AdsBoard({
  query,
  onEditProperties,
}: {
  query: UseQueryResult<AdsBoardData>;
  /** Открыть окно «Привязать объекты» — оно живёт на странице, одно на все вкладки. */
  onEditProperties: (target: AdSheetTarget) => void;
}) {
  const { data, isLoading, isError, error, refetch } = query;
  const canEdit = useCanWriteAds();
  const [filter, setFilter] = useState<StateFilter>("all");
  const { data: accounts } = useAdAccounts();

  if (isLoading) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем объявления
      </div>
    );
  }
  if (isError) {
    /* «Подключите рекламный кабинет» — утверждение о НАСТРОЙКЕ, сделанное по
       упавшему запросу: владелец шёл переподключать уже работающий кабинет
       (аудит 22.08.2026, раунд 6). */
    return (
      <div className="state err">
        <span className="dot crit" />{" "}
        {error instanceof Error ? error.message : "Объявления не загрузились"} — это сбой связи, а не
        отключённый кабинет.{" "}
        <button
          className="lk"
          type="button"
          style={{ color: "inherit", textDecoration: "underline" }}
          onClick={() => refetch()}
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!data || data.rows.length === 0) {
    return (
      <div className="empty">
        <span className="ic">
          <ImageIcon className="i" aria-hidden />
        </span>
        <p>Объявлений пока нет.</p>
        <span className="sub">Подключите рекламный кабинет в Настройках — CRM подтянет всё сама.</span>
      </div>
    );
  }

  const { totals } = data;
  const rows = data.rows.filter((r) =>
    filter === "all" ? true : filter === "running" ? r.delivery === "RUNNING" : r.delivery !== "RUNNING"
  );

  /**
   * СВОДКА — ОНА ЖЕ ФИЛЬТР. Число на кнопке видно до нажатия, поэтому пустой
   * список после клика никогда не выглядит сломанной кнопкой (тот же приём, что
   * в «Вакансиях» после разбора 03.09.2026).
   */
  const segs: { key: StateFilter; value: number; label: string }[] = [
    { key: "all", value: totals.total, label: "Всего объявлений" },
    { key: "running", value: totals.running, label: "Идут сейчас" },
    { key: "stopped", value: totals.stopped + totals.stalled, label: "Не идут" },
  ];

  return (
    <div>
      <div className="hscroll">
        <div className="seg" role="tablist" aria-label="Состояние объявлений">
          {segs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={filter === t.key}
              onClick={() => setFilter(t.key)}
            >
              {t.label} <span className="n">{t.value}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Чем платят за рекламу — одна тихая строка: директор спрашивает
          это раз в месяц, но спрашивает всегда. */}
      {(accounts?.accounts ?? []).length > 0 && (
        <div className="quiet" style={{ marginTop: 12 }}>
          <span className="dot" />
          <span className="txt">
            {(accounts?.accounts ?? [])
              .map(
                (a) =>
                  `${a.fundingSource ?? "способ оплаты не виден"}${
                    a.balance != null && a.balance > 0 ? ` · долг ${formatMoneyExact(a.balance, a.currency)}` : ""
                  }`
              )
              .join(" · ")}
          </span>
        </div>
      )}

      {/* РЕАЛЬНАЯ ЦЕНА КЛИЕНТА по всем объявлениям периода + одна видимая фраза, чем она
          отличается от «обращений» Meta (на телефоне `title` строк не виден). */}
      <AdLeadStatsLine stats={totals.leadStats} spendTjs={totals.periodTjs} />
      {totals.leadStats && <LeadVsMetaNote />}
      {data.leadsTruncated && (
        <p className="state">Клиентов с рекламы за период больше предела выборки — цена клиента посчитана по неполному набору.</p>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          <p>
            {filter === "running"
              ? "Сейчас не идёт ни одно объявление — деньги не тратятся."
              : "Все объявления идут: остановленных нет."}
          </p>
        </div>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {rows.map((row, i) => (
            <BoardRow
              key={row.id}
              row={row}
              last={i === rows.length - 1}
              onEdit={canEdit ? () => onEditProperties(adTargetFromRow(row)) : undefined}
            />
          ))}
        </div>
      )}

      {data.truncated && (
        <p className="state">Показаны первые 500 объявлений — итоги выше считаются по ним же.</p>
      )}
    </div>
  );
}

function BoardRow({ row, last, onEdit }: { row: AdBoardRow; last: boolean; onEdit?: () => void }) {
  const state = DELIVERY[row.delivery];
  const perConversation = row.period.conversations > 0 ? row.period.spendTjs / row.period.conversations : null;
  const properties = row.properties ?? [];
  const multi = properties.length > 1;
  // Без объекта объявление называет себя первой строкой самой публикации: имя
  // кампании Meta режет до «Публикация: "Продаётся квартира"», и такие строки
  // в отчёте неотличимы одна от другой. С несколькими объектами заголовок тоже
  // общий: «№107» назвал бы объявление про четыре квартиры именем одной.
  const subject =
    row.property && !multi
      ? `№${row.property.shortId} · ${row.property.title}`
      : row.headline || row.campaignName || row.name;
  const cover = (multi ? null : row.property?.coverUrl) ?? row.previewUrl ?? null;
  const assetCount = row.assetCount ?? 0;
  // Реклама самого агентства объекта не ждёт — кнопку «Привязать» ей не рисуем,
  // иначе она дублировалась бы на каждой брендовой строке списка.
  const canLink = !!onEdit && (!row.brand || properties.length > 0);
  const leadText = describeLeadStats(row.leadStats, row.period.spendTjs);
  const showExtras = properties.length > 0 || assetCount > 1 || !!row.needsReview || canLink;

  return (
    <div style={last ? undefined : { borderBottom: "1px solid var(--line-soft)" }}>
      <div className="prow wrapt" style={{ borderBottom: 0 }}>
        <span className="ph" aria-hidden>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <ImageIcon className="i" />}
        </span>

        <div className="t">
          <b>
            {row.property && !multi ? (
              <Link className="lk" to={`/properties/${row.property.shortId}`}>
                {subject}
              </Link>
            ) : (
              subject
            )}
          </b>
          {/* Одна строка примет: к чему привязано, цель кампании, ссылка на пост,
              сроки трат. Цвет здесь несёт только метка состояния справа. */}
          <span>
            {properties.length === 0 && !row.property && (row.brand ? "реклама агентства · " : "без объекта · ")}
            {row.objective && OBJECTIVE_LABEL[row.objective] ? `${OBJECTIVE_LABEL[row.objective]} · ` : ""}
            {shortDate(row.firstSpendAt)}
            {row.lastSpendAt && row.lastSpendAt !== row.firstSpendAt ? ` — ${shortDate(row.lastSpendAt)}` : ""}
            {row.activeDays > 0 ? ` · ${row.activeDays} дн. с тратами` : " · трат не было"}
            {row.postUrl && (
              <>
                {" · "}
                <a className="lk" href={row.postUrl} target="_blank" rel="noreferrer">
                  пост <ExternalLink className="i" aria-hidden />
                </a>
              </>
            )}
          </span>
        </div>

        {/* Деньги: за период и, мелким, за всё время — так ноль объясняет себя.
            Это итог ВСЕГО объявления: он сходится с кабинетом Meta. */}
        <span className="pr">
          {formatMoneyExact(row.period.spendTjs, "TJS")}
          {row.lifetime.spendTjs !== row.period.spendTjs && (
            <small>{formatMoneyExact(row.lifetime.spendTjs, "TJS")} за всё время</small>
          )}
        </span>

        <span className={row.delivery === "RUNNING" ? "chip ok" : "chip"} title={state.hint}>
          <span className={DOT[row.delivery]} />
          {state.label}
        </span>

        {/* Отдача */}
        <span className="pr">
          {row.period.conversations}
          <small>{perConversation !== null ? `по ${formatMoneyExact(perConversation, "TJS")}` : "обращений нет"}</small>
        </span>
      </div>

      {/* Клиенты CRM и цена клиента — рядом с «обращениями» Meta из колонки выше. */}
      {leadText && (
        <div style={{ padding: "0 var(--s2)" }}>
          <AdLeadStatsLine stats={row.leadStats} spendTjs={row.period.spendTjs} />
        </div>
      )}

      {/* Объекты объявления — отдельной строкой под основной: чипы с
          миниатюрами не должны сжиматься в колонку названия. */}
      {showExtras && (
        <div style={{ padding: "0 var(--s2) var(--s3)" }}>
          <AdPropertyChips properties={properties} />
          <div className="wrap" style={{ gap: 8, marginTop: 6 }}>
            <AdMaterialsNote
              assetCount={assetCount}
              linked={properties.length}
              needsReview={!!row.needsReview}
              brand={row.brand}
            />
            {canLink && (
              <button
                className="pill ghost sm"
                type="button"
                onClick={onEdit}
                aria-label={`${properties.length > 0 ? "Изменить объекты" : "Привязать объекты"}: ${subject}`}
              >
                {properties.length > 0 ? "Изменить объекты" : "Привязать объекты"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

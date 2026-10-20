import { useMemo, useState } from "react";
import { Image as ImageIcon, Plus, X } from "lucide-react";
import type { AdBoardProperty } from "@royal-home/shared";
import { useProperties, usePropertyByShortId, useSetAdProperties, type UnmatchedCandidate } from "../../hooks/useAds";
import { mergeSearchResults, parsePropertySearch } from "../../lib/adPropertySearch";
import {
  AD_MAX_PROPERTIES,
  AD_MAX_WEIGHT,
  formatPct,
  parseWeight,
  SHARE_SUM_TOLERANCE,
  sharesToWeights,
  splitEvenly,
  weightToField,
} from "../../lib/adsView";
import { pluralizeRu } from "../../lib/format";
import { Rh2Sheet } from "../rh2/Rh2Sheet";

/**
 * ОКНО «ПРИВЯЗАТЬ ОБЪЕКТЫ» — несколько объектов у одного объявления (03.10.2026).
 *
 * Повод — «гибкое» объявление «Умед хонахо»: четыре ролика про четыре квартиры в
 * одном объявлении, а CRM записывала весь расход на первый объект. Здесь человек
 * собирает список объектов и говорит, какую долю денег объявления получает
 * каждый; сервер нормирует доли до 100 % (`PATCH /ads/:id/properties`).
 *
 * ПОИСК — тот же `useProperties`, что и у «найти объект вручную» в галерее
 * «Привязать» (по номеру или адресу, параметр `q`): второй реализации нет.
 *
 * ДОЛИ. В поле — проценты. «Поровну» делит ровно на 100 (33,34 + 33,33 + 33,33),
 * живая сумма видна под списком. При открытии доли берутся у сервера и тоже
 * складываются ровно в 100 (`sharesToWeights`), так что нетронутое окно не
 * жалуется на «99,99 %». Добавленный объект приходит с ПУСТОЙ долей: введённые
 * вручную 70/30 не затираются, а окно просит распределить остаток. Пока у объекта
 * нет доли, сохранить нельзя. Остальное сервер приводит к 100 % сам, и окно честно
 * предупреждает об этом, а не молча правит.
 *
 * Один адаптивный файл: окно — `Rh2Sheet`, на телефоне оно само становится
 * нижней шторкой, отдельной мобильной копии нет.
 */

/** Что окно знает об объявлении: хватает и строки доски, и карточки «Привязать». */
export interface AdSheetTarget {
  id: string;
  title: string;
  /** Сколько материалов в объявлении по данным Meta; нет данных — null. */
  assetCount: number | null;
  /** Уже привязанные объекты с долями. */
  properties: AdBoardProperty[];
  /** Подсказки сервера по словам из подписи — добавляются одним касанием. */
  candidates?: UnmatchedCandidate[];
}

interface Picked {
  id: string;
  shortId: number;
  title: string | null;
  coverUrl: string | null;
  /** Строка из поля ввода, а не число: «33,» в процессе набора не должно ломаться. */
  weight: string;
}

function initialPicked(target: AdSheetTarget): Picked[] {
  const weights = sharesToWeights(target.properties.map((p) => p.share));
  return target.properties.map((p, i) => ({
    id: p.id,
    shortId: p.shortId,
    title: p.title,
    coverUrl: p.thumbUrl,
    weight: weightToField(weights[i] ?? 0),
  }));
}

export function AdPropertiesSheet({ target, onClose }: { target: AdSheetTarget; onClose: () => void }) {
  const save = useSetAdProperties();
  const [picked, setPicked] = useState<Picked[]>(() => initialPicked(target));
  const [query, setQuery] = useState("");
  // Номер («103», «№103», «ОБ-000103») открывает карточку по номеру и ставит её первой;
  // текст идёт тем же серверным поиском, что и раньше (lib/adPropertySearch.ts).
  const parsed = parsePropertySearch(query);
  const textSearching = parsed.text.length > 1;
  const searching = parsed.shortId != null || textSearching;
  const text = useProperties(parsed.text, textSearching);
  const exact = usePropertyByShortId(parsed.shortId);
  const found = text.data;
  const isFetching = text.isFetching || exact.isFetching;
  const searchFailed = text.isError || exact.isError;

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);
  const weights = picked.map((p) => parseWeight(p.weight));
  const allValid = weights.every((w) => w !== null);
  // Пустое поле — «доля ещё не назначена» (новый объект), а не ошибка ввода.
  const emptyCount = picked.filter((p) => p.weight.trim() === "").length;
  const hasBadInput = picked.some((p, i) => weights[i] === null && p.weight.trim() !== "");
  const sum = weights.reduce<number>((acc, w) => acc + (w ?? 0), 0);
  const sumOk = Math.abs(sum - 100) < SHARE_SUM_TOLERANCE;
  const remainder = Math.max(0, Math.round((100 - sum) * 100) / 100);
  const hadBefore = target.properties.length > 0;
  const full = picked.length >= AD_MAX_PROPERTIES;

  const add = (c: { id: string; shortId: number; title: string | null; coverUrl: string | null }) => {
    if (pickedIds.has(c.id) || full) return;
    // Новому объекту — пустое поле: уже введённые вручную доли не трогаем. Остаток
    // подсказывает строка под списком, а «Поровну» делит всё заново по кнопке.
    // Первый объект в пустом списке — сразу 100 %: делить пока не с кем.
    setPicked((prev) => [...prev, { ...c, weight: prev.length === 0 ? "100" : "" }]);
  };

  const remove = (id: string) => setPicked((prev) => prev.filter((p) => p.id !== id));
  const setWeight = (id: string, weight: string) =>
    setPicked((prev) => prev.map((p) => (p.id === id ? { ...p, weight } : p)));
  const evenly = () => {
    const even = splitEvenly(picked.length);
    setPicked((prev) => prev.map((p, i) => ({ ...p, weight: weightToField(even[i] ?? 0) })));
  };

  // Пустой список — «снять привязку», и это допустимо только если она была.
  const canSave = !save.isPending && (picked.length === 0 ? hadBefore : allValid);

  const submit = () => {
    if (!canSave) return;
    save.mutate(
      {
        id: target.id,
        items: picked.map((p, i) => ({ propertyId: p.id, weight: weights[i] ?? 1 })),
      },
      { onSuccess: onClose }
    );
  };

  const suggestions = (target.candidates ?? []).filter((c) => !pickedIds.has(c.id));
  const results = mergeSearchResults(exact.data, found, pickedIds, 6);
  const mismatch = target.assetCount != null && target.assetCount > picked.length;

  return (
    <Rh2Sheet
      title="Привязать объекты"
      ariaLabel={`Привязать объекты к объявлению ${target.title}`}
      wide
      onClose={onClose}
      onSubmit={submit}
      closeOnBackdrop={false}
      footer={
        <>
          <button className="pill" type="submit" disabled={!canSave}>
            {save.isPending ? "Сохраняем…" : picked.length === 0 && hadBefore ? "Снять привязку" : "Сохранить"}
          </button>
          <button className="pill ghost" type="button" onClick={onClose}>
            Отмена
          </button>
        </>
      }
    >
      {/* Заголовок — обычный блок, а не `.state` (тот флекс: слова превращались в узкие колонки). */}
      <div style={{ paddingBottom: 4 }}>
        <b style={{ display: "block", color: "var(--ink)", fontSize: "var(--fs-15)", overflowWrap: "anywhere" }}>
          {target.title}
        </b>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "var(--fs-14)" }}>
          {target.assetCount != null && (
            <>
              В объявлении {target.assetCount}{" "}
              {pluralizeRu(target.assetCount, ["материал", "материала", "материалов"])}.{" "}
            </>
          )}
          Деньги объявления делятся между выбранными объектами по долям. Итог объявления остаётся прежним и
          сходится с кабинетом Meta.
        </p>
      </div>

      {mismatch && (
        <div className="quiet warn" role="status">
          <span className="dot warn" />
          <span className="txt">
            Материалов {target.assetCount}, объектов выбрано {picked.length}. Если в объявлении несколько
            квартир, добавьте их все — иначе доля уйдёт не туда.
          </span>
        </div>
      )}

      {/* Выбранные объекты и их доли. */}
      <div className="sec-h stack" style={{ marginTop: 12 }}>
        <h3>Выбрано: {picked.length}</h3>
        {(picked.length > 1 || emptyCount > 0) && (
          <button className="lnk" type="button" onClick={evenly}>
            Поровну
          </button>
        )}
      </div>

      {picked.length === 0 ? (
        <p className="state" role="status">
          {hadBefore
            ? "Список пуст: после сохранения привязка будет снята."
            : "Объектов пока нет. Найдите объект ниже и добавьте."}
        </p>
      ) : (
        <div className="list">
          {picked.map((p, i) => {
            const w = weights[i];
            const empty = p.weight.trim() === "";
            const bad = w === null && !empty;
            const normalized = w !== null && sum > 0 ? (w / sum) * 100 : null;
            return (
              <div className="prow wrapt" key={p.id}>
                <span className="ph" aria-hidden>
                  {p.coverUrl ? <img src={p.coverUrl} alt="" loading="lazy" /> : <ImageIcon className="i" />}
                </span>
                <div className="t">
                  <b>
                    №{p.shortId}
                    {p.title ? ` · ${p.title}` : ""}
                  </b>
                  <span>{normalized !== null && !sumOk ? `итоговая доля ${formatPct(normalized)}` : " "}</span>
                </div>
                <div className="act">
                  <label className={`fld${bad ? " bad" : ""}`} style={{ width: 112 }}>
                    <span className="vh">Доля объекта №{p.shortId}, %</span>
                    <input
                      inputMode="decimal"
                      value={p.weight}
                      placeholder={empty && remainder > 0 ? weightToField(remainder) : undefined}
                      onChange={(e) => setWeight(p.id, e.target.value)}
                      aria-invalid={bad}
                      aria-describedby="ad-sheet-sum"
                      autoComplete="off"
                    />
                  </label>
                  <span aria-hidden>%</span>
                  <button
                    className="pill ghost sm"
                    type="button"
                    onClick={() => remove(p.id)}
                    aria-label={`Убрать объект №${p.shortId}`}
                  >
                    <X className="i" aria-hidden />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Живая сумма долей. Пустая доля запрещает сохранение; неровная сумма — нет: сервер нормирует до 100 %. */}
      {picked.length > 0 && (
        <div id="ad-sheet-sum" className={`quiet${sumOk && allValid ? "" : " warn"}`} aria-live="polite">
          <span className={sumOk && allValid ? "dot ok" : "dot warn"} />
          <span className="txt">
            {hasBadInput
              ? `Доля — число больше нуля и не выше ${AD_MAX_WEIGHT}.`
              : emptyCount > 0
                ? remainder > 0
                  ? `Распределите остаток ${formatPct(remainder)}: укажите долю ${
                      emptyCount > 1 ? "объектам без доли" : "объекту без доли"
                    } или нажмите «Поровну».`
                  : `Укажите долю ${emptyCount > 1 ? "объектам без доли" : "объекту без доли"} или нажмите «Поровну».`
                : sumOk
                ? "Сумма долей: 100 %."
                : `Сумма долей: ${formatPct(sum)}. При сохранении доли пересчитаются до 100 %.`}
          </span>
        </div>
      )}

      {/* Подсказки сервера. */}
      {suggestions.length > 0 && !full && (
        <>
          <div className="sec-h stack" style={{ marginTop: 16 }}>
            <h3>Похоже на эти объекты</h3>
          </div>
          <div className="list">
            {suggestions.map((c) => (
              <CandidateRow
                key={c.id}
                shortId={c.shortId}
                title={c.title}
                sub={c.address}
                coverUrl={c.coverUrl}
                onAdd={() => add(c)}
              />
            ))}
          </div>
        </>
      )}

      {/* Поиск. Enter в поле не отправляет форму — его читают как «найти». */}
      <div className="sec-h stack" style={{ marginTop: 16 }}>
        <h3>Найти объект</h3>
      </div>
      <label className="fld">
        <span className="vh">Номер объекта или адрес</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          placeholder="Номер объекта или адрес"
          autoComplete="off"
        />
      </label>
      {full && <p className="state">Достигнут предел: {AD_MAX_PROPERTIES} объектов в одном объявлении.</p>}
      {searching && (
        <div className="list" aria-busy={isFetching}>
          {searchFailed && results.length === 0 ? (
            <p className="state err">
              <span className="dot crit" /> Поиск не сработал — это не значит, что объекта нет.
            </p>
          ) : isFetching && results.length === 0 ? (
            <p className="state">Ищем…</p>
          ) : results.length === 0 ? (
            <p className="state">Ничего не нашлось среди ещё не выбранных объектов.</p>
          ) : (
            results.map((p) => (
              <CandidateRow
                key={p.id}
                shortId={p.shortId}
                title={p.title}
                sub={p.address}
                coverUrl={p.coverUrl}
                // Пока идёт поиск, список — от прошлого запроса: добавить можно не тот.
                disabled={isFetching || full}
                onAdd={() => add(p)}
              />
            ))
          )}
        </div>
      )}

      {save.isError && (
        <div className="state err" role="alert">
          <span className="dot crit" />{" "}
          {save.error instanceof Error ? save.error.message : "Не удалось сохранить привязку"}
        </div>
      )}
    </Rh2Sheet>
  );
}

function CandidateRow({
  shortId,
  title,
  sub,
  coverUrl,
  disabled,
  onAdd,
}: {
  shortId: number;
  title: string;
  sub?: string;
  coverUrl: string | null;
  disabled?: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="prow wrapt">
      <span className="ph" aria-hidden>
        {coverUrl ? <img src={coverUrl} alt="" loading="lazy" /> : <ImageIcon className="i" />}
      </span>
      <div className="t">
        <b>
          №{shortId} · {title}
        </b>
        {sub ? <span>{sub}</span> : null}
      </div>
      <div className="act">
        <button
          className="pill ghost sm"
          type="button"
          onClick={onAdd}
          disabled={disabled}
          aria-label={`Добавить объект №${shortId}`}
        >
          <Plus className="i" aria-hidden /> Добавить
        </button>
      </div>
    </div>
  );
}

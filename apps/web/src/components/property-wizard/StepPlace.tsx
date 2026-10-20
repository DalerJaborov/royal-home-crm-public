import { Suspense, useEffect, useRef, useState } from "react";
import type { District } from "../../types";
import { DISTRICT_COORDS, districtCenter } from "../../lib/districtCoords";
import { api } from "../../lib/api";
import { isSameDistrictName } from "../../lib/pointAddress";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { resolveGeoPlace, type GeoResolveCandidate } from "../../hooks/usePropertiesMap";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useLandmarks } from "../../hooks/useLandmarks";
import { useReverseGeocode } from "./useReverseGeocode";
import { useMapDistrict } from "./useMapDistrict";
import { nextLandmarkValue, usePointLandmarks } from "./usePointLandmarks";
import { useDuplicateAddress } from "./useDuplicateAddress";
import { DuplicateAddressWarning } from "./DuplicateAddressWarning";
import type { WizardValues } from "./types";

/**
 * ШАГ 3 — ГДЕ. Облик — артефакт владельца (docs/pult/theme-2026/artifact-wizard-property-15-09.html,
 * функция stepPlace/mapBlock): карта первым блоком, поверх неё строка поиска
 * `.msearch` с подсказками `.sugg`, ниже районы лентой `.segs`. Разметка взята
 * из артефакта дословно, ПОД НЕЙ — та же логика, что была: геокодер, подсказки
 * из `/geo/resolve`, подбор района по точке. Ничего в данных не меняется.
 *
 * Район объекта в базе — обязательная ссылка на справочник (Property.districtId),
 * поэтому его нельзя оставить «как получится». Мастер ПРЕДЛАГАЕТ район двумя
 * способами: по названию из ответа Nominatim, а если оно не совпало ни с одним
 * из четырёх районов агентства — по ближайшему центру района из
 * `lib/districtCoords.ts`. Предложение всегда видно лентой и всегда
 * переключается рукой: подставленное значение — это удобство, а последнее
 * слово за агентом, который стоит на месте.
 *
 * АРТЕФАКТ ПОКАЗЫВАЕТ ТЕГ «наш» У СВОИХ АДРЕСОВ — в реальном справочнике
 * (`GET /geo/resolve`) такого признака нет: это подсказки по типу объекта
 * (улица/мкр/дом/ориентир), а не «наш/чужой». Красить их «нашими» значило бы
 * выдумывать данные, которых сервер не отдаёт, поэтому тег здесь показывает
 * честный тип подсказки.
 */
/**
 * Leaflet — самая тяжёлая зависимость бандла (около 150 КБ), и грузить её
 * вместе с первым шагом мастера незачем: до карты агент доходит через минуту
 * съёмки, а на слабом интернете эти килобайты стоят ожидания на пустом месте.
 * Тот же приём, что в списке объектов (Properties.tsx).
 */
const MapPointPicker = lazyWithReload(() =>
  import("./MapPointPicker").then((m) => ({ default: m.MapPointPicker }))
);

export function StepPlace({
  values,
  errors,
  districts,
  districtsLoading,
  onChange,
  mapNote,
}: {
  values: WizardValues;
  errors: Record<string, string>;
  districts: District[];
  districtsLoading: boolean;
  onChange: (patch: Partial<WizardValues>) => void;
  /** Строка под картой от мастера — «точку по фото поставили на дом …». */
  mapNote?: string | null;
}) {
  const point = values.lat !== null && values.lng !== null ? { lat: values.lat, lng: values.lng } : null;
  const { result, status } = useReverseGeocode(point);
  // Район по нашей карте (границы районов) — сильнее грубой подсказки ниже.
  const mapDistrict = useMapDistrict(point);
  const duplicates = useDuplicateAddress(values);
  // Ориентир по точке (владелец 25.09.2026): один-два места рядом ставятся в
  // поле сами, пока агент его не правил. `landmarkAuto` — что сайт подставил
  // последним; по нему видно, трогал ли поле человек. Правило — nextLandmarkValue.
  const landmarkSuggestion = usePointLandmarks(point);
  const [landmarkAuto, setLandmarkAuto] = useState<string | null>(null);
  useEffect(() => {
    if (landmarkSuggestion == null) return;
    const next = nextLandmarkValue(values.landmark, landmarkAuto, landmarkSuggestion);
    if (next === null && values.landmark.trim() !== landmarkSuggestion.trim()) return; // правил агент
    setLandmarkAuto(landmarkSuggestion);
    if (next !== null) onChange({ landmark: next });
    // Реагируем на новый ответ по точке, а не на каждое изменение формы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landmarkSuggestion]);
  const [moving, setMoving] = useState(false);
  /**
   * «АДРЕС ПРАВЛЕН РУКАМИ» — распознаётся ОДИН РАЗ за вход на шаг, первым же
   * ответом геокодера, и дальше живёт обычным состоянием.
   *
   * Почему не флаг «с нуля при каждом монтировании»: StepPlace размонтируется
   * при переходе на другой шаг, а держать признак в values.* нельзя. Старый код
   * инициализировал его как «адрес непустой → правлен», и при ВОЗВРАТЕ на шаг
   * подставленный самой картой адрес навсегда считался правленым — подсказка
   * переставала обновляться от сдвига карты.
   *
   * Почему не чистое сравнение на каждом рендере (первая попытка этой правки):
   * после сдвига карты ответ геокодера уже НОВЫЙ, а поле ещё держит прошлый
   * подставленный адрес — сравнение объявляло бы его «правленым» и адрес не
   * обновлялся бы больше никогда. Сравнивать можно только с ПЕРВЫМ ответом
   * после входа на шаг: точка, пока агент отсюда не ушёл, та же самая.
   *
   * `null` — «ещё не знаем»: геокодер не ответил. До ответа непустое поле
   * считаем правленым (осторожнее промолчать, чем затереть).
   */
  const [addressManual, setAddressManual] = useState<boolean | null>(null);
  const addressEdited = addressManual ?? values.address.trim().length > 0;
  const appliedRef = useRef<string | null>(null);

  /**
   * ПОДСКАЗКА АДРЕСА ПРИ ВВОДЕ ТЕКСТОМ — макет «Мастер объекта на весь
   * экран» (артефакт 6df8598b, раздел «Адрес: три варианта», вариант 2,
   * выбранный владельцем): «агент набирает три буквы — CRM подсказывает из
   * нашей базы». Бэкенд под это уже был построен (`docs/geo-match-plan-12-09.md`,
   * `GET /geo/resolve`) но шаг «Где» им не пользовался ни разу — здесь
   * дописано ровно то подключение, а не третий парсер текста. Карта ниже не
   * убрана: агент по-прежнему может дотянуть точку руками, подсказка — это
   * быстрый путь для тех, кто адрес знает и хочет его сразу напечатать.
   */
  const [suggestions, setSuggestions] = useState<GeoResolveCandidate[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestAbortRef = useRef<{ query: string } | null>(null);
  // Шаг живёт ровно до ухода с него, ответ справочника может прийти позже:
  // без этого флага setState прилетал бы в размонтированный компонент.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    const q = values.address.trim();
    if (!addressEdited || q.length < 2) {
      setSuggestions([]);
      return;
    }
    const token = { query: q };
    suggestAbortRef.current = token;
    const timer = setTimeout(() => {
      resolveGeoPlace(q)
        .then((result) => {
          if (!aliveRef.current || suggestAbortRef.current !== token) return; // ушли с шага или адрес сменился
          const items = result ? [result, ...result.alternatives] : [];
          setSuggestions(items);
        })
        .catch(() => {
          if (aliveRef.current && suggestAbortRef.current === token) setSuggestions([]);
        });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.address, addressEdited]);

  function applySuggestion(candidate: GeoResolveCandidate) {
    // Выбран конкретный дом — адрес окончательный. Выбрана улица, микрорайон или
    // ориентир — это только «куда вести карту»: номера дома в нём нет, и адрес
    // остаётся автоматическим, чтобы номер подставился, когда агент поставит
    // точку на свой дом (владелец 28.09.2026: «номер дома не выходит»).
    setAddressManual(candidate.targetType === "building");
    appliedRef.current = candidate.name;
    setSuggestOpen(false);
    setSuggestions([]);
    onChange({ address: candidate.name, lat: candidate.lat, lng: candidate.lng });
    // Район — по границе района на нашей карте, как у точки, поставленной руками.
    // Ближайший «центр района» — только если карта не ответила: по центрам
    // соседние районы путаются у самой границы.
    const fallback = () => {
      const guess = pickDistrict(districts, null, { lat: candidate.lat, lng: candidate.lng });
      if (guess) onChange({ districtId: guess.id });
    };
    api<{ district: { id: string; name: string } | null }>(`/geo/lookup?lat=${candidate.lat}&lng=${candidate.lng}`)
      .then((res) => {
        const own = res.district ? districts.find((d) => d.id === res.district?.id) : undefined;
        if (own) onChange({ districtId: own.id });
        else fallback();
      })
      .catch(fallback);
  }

  useEffect(() => {
    if (addressManual !== null || !result) return;
    setAddressManual(values.address.trim().length > 0 && values.address !== result.address);
    // values.address читаем в момент первого ответа — дальше решение принято.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, addressManual]);

  useEffect(() => {
    if (!result) return;
    // Район подставляем только пока агент его не выбрал: свой выбор человека
    // подсказка перебивать не должна.
    if (!values.districtId && districts.length > 0) {
      // Сначала наша карта (границы районов), и только если она молчит —
      // прежняя грубая подсказка. См. useMapDistrict.ts.
      const guess = mapDistrict ?? pickDistrict(districts, result.districtName, point);
      if (guess) onChange({ districtId: guess.id });
    }
    if (addressEdited || !result.address) return;
    if (appliedRef.current === result.address) return;
    appliedRef.current = result.address;
    onChange({ address: result.address });
    // onChange/values намеренно вне зависимостей: реагируем на новый ответ
    // геокодера, а не на каждое изменение формы (иначе цикл).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, districts.length]);

  const suggestion = result?.address ?? "";
  const canSuggest = addressEdited && suggestion && suggestion !== values.address;

  // Район, в котором СЕЙЧАС стоит точка на карте — тем же способом, каким
  // подбирается автоподсказка. Если агент уже выбрал район руками (или его
  // подставили раньше), а потом подвинул карту в другой район, эти два
  // значения разойдутся — не переключаем сами, только предупреждаем.
  const pointDistrict = mapDistrict ?? pickDistrict(districts, result?.districtName ?? null, point);
  const selectedDistrict = districts.find((d) => d.id === values.districtId) ?? null;
  const districtMismatch =
    !!values.districtId && !!pointDistrict && !!selectedDistrict && pointDistrict.id !== selectedDistrict.id;

  const addressStatus =
    errors.address ||
    (values.offSite
      ? ""
      : moving
        ? "Отпустите карту — определю адрес по метке."
        : status === "loading"
          ? "Определяю адрес по точке…"
          : status === "offline"
            ? "Нет сети — впишите адрес сами, подсказка подхватит точку, когда интернет вернётся."
            : status === "failed"
              ? "Сервис адресов не ответил — впишите адрес сами, точка на карте уже сохранена."
              : status === "empty"
                ? "У этой точки нет адреса ни в OpenStreetMap, ни в нашем справочнике — впишите его сами."
                : "");

  return (
    <>
      {/* Карта — только для объекта на сайт. Несайтовый объект (values.offSite)
          картой не пользуется: PropertyWizard уже взял координаты сам, тихо,
          геопозицией браузера (владелец 14.09.2026 — «только для своих» не
          спрашивает ни район, ни адрес вовсе, координаты телефона и есть
          координаты объекта). Адрес и район здесь остаются НЕОБЯЗАТЕЛЬНЫМ
          удобством — впишет агент, если знает точнее того, что достроит
          сервер по точке (lookupGeoPoint, routes/properties/crud.ts). */}
      <section className="blk" style={{ padding: values.offSite ? 12 : 8 }}>
        {!values.offSite ? (
          <div className="map">
            <Suspense fallback={<div className="empty">Загружаю карту…</div>}>
              <MapPointPicker
                value={point}
                fallbackCenter={districtCenter(districts.find((d) => d.id === values.districtId)?.name)}
                onChange={(coords) => onChange({ lat: coords.lat, lng: coords.lng })}
                onLocating={setMoving}
                note={mapNote}
              />
            </Suspense>
            <div className="msearch">
              <div className="bar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.2-3.2" />
                </svg>
                <input
                  value={values.address}
                  autoComplete="off"
                  placeholder="Адрес или ориентир"
                  aria-label="Адрес или ориентир"
                  data-testid="wizard-address-input"
                  onChange={(e) => {
                    // Набор руками — решение окончательное: подсказка больше не
                    // перетирает поле, а предлагается отдельной ссылкой ниже.
                    setAddressManual(true);
                    setSuggestOpen(true);
                    onChange({ address: e.target.value });
                  }}
                  onFocus={() => setSuggestOpen(true)}
                  // Escape закрывает список, не стирая набранное, — как в остальных
                  // выпадающих списках CRM (useDismissableMenu).
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && suggestOpen) {
                      e.stopPropagation();
                      setSuggestOpen(false);
                    }
                  }}
                  // Задержка перед закрытием — иначе клик по подсказке не успевает
                  // дойти до onMouseDown/onClick: blur снимает список раньше.
                  onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                />
              </div>
              {suggestOpen && addressEdited && values.address.trim().length >= 2 && (
                <AddressSuggestions
                  suggestions={suggestions}
                  onPick={(s) => applySuggestion(s)}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="f">
            <label htmlFor="wizard-address-input-offsite">Адрес</label>
            <input
              id="wizard-address-input-offsite"
              className="txt"
              value={values.address}
              autoComplete="off"
              placeholder="Улица и дом"
              aria-label="Адрес"
              data-testid="wizard-address-input"
              onChange={(e) => onChange({ address: e.target.value })}
            />
          </div>
        )}
        {addressStatus && (
          <p style={{ marginTop: 8, fontSize: 12, color: errors.address ? "var(--warn)" : "var(--muted)" }} role="status" data-testid="wizard-address-status">
            {addressStatus}
          </p>
        )}
        {canSuggest && (
          <button
            type="button"
            className="chip warn"
            style={{ marginTop: 8 }}
            aria-label={`Подставить адрес по карте: ${suggestion}`}
            data-testid="wizard-address-apply"
            onClick={() => {
              // Согласился с картой — дальше адрес снова «автоматический»
              // и обновляется сам при следующем сдвиге.
              appliedRef.current = suggestion;
              setAddressManual(false);
              onChange({ address: suggestion });
            }}
          >
            Подставить по карте: {suggestion}
          </button>
        )}
      </section>

      <section className="blk">
        <LandmarkField
          value={values.landmark}
          auto={landmarkAuto !== null && values.landmark.trim() !== "" && values.landmark === landmarkAuto}
          onChange={(landmark) => onChange({ landmark })}
        />
      </section>

      <section className="blk">
        <div className="segs" role="tablist" aria-label="Район">
          {/* Состояние вкладки — `aria-selected`, а не `aria-pressed`
              (19.09.2026): внутри `role="tablist"` оно называется именно так, а
              пара aria-pressed + role="tab" валится у axe правилом
              aria-allowed-attr (critical) — то же самое уже чинили в
              components/mobile/mh/MhList.tsx. */}
          {districts.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={values.districtId === d.id}
              onClick={() => onChange({ districtId: d.id })}
            >
              {d.name}
            </button>
          ))}
        </div>
        {(errors.districtId || districtsLoading) && (
          <p style={{ marginTop: 8, fontSize: 12, color: errors.districtId ? "var(--warn)" : "var(--muted)" }}>
            {errors.districtId || "Загружаю справочник районов…"}
          </p>
        )}
        {districtMismatch && pointDistrict && (
          <button
            type="button"
            className="chip warn"
            style={{ marginTop: 8 }}
            aria-label={`Переключить район на ${pointDistrict.name}`}
            data-testid="wizard-district-switch"
            onClick={() => onChange({ districtId: pointDistrict.id })}
          >
            Точка в районе {pointDistrict.name} — переключить
          </button>
        )}
      </section>
    </>
  );
}

/**
 * ОРИЕНТИР ОБЪЕКТА (пункт 10 владельца, 23.09.2026) — короткая фраза вроде
 * «рядом с ТЦ Садбарг», «за Овиром»: помогает покупателю и сотрудникам понять
 * расположение объекта, когда точного адреса недостаточно.
 *
 * НЕ ТО ЖЕ САМОЕ, что справочник ориентиров (useLandmarks/Landmark) выше по
 * файлу — тот участвует в подборе объекта под клиента по расстоянию
 * (lib/landmarkPick.ts) и живёт отдельной таблицей. Здесь — просто текст на
 * карточке объекта, а справочник подключён только подсказкой: агент видит
 * готовые названия, но свободный текст всегда можно напечатать и сохранить,
 * даже если в справочнике ничего похожего нет.
 */
function LandmarkField({ value, auto, onChange }: { value: string; auto: boolean; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const debounced = useDebouncedValue(value.trim(), 350);
  const searchActive = open && debounced.length >= 2;
  const { data } = useLandmarks({ q: debounced, pageSize: 5 }, { enabled: searchActive });
  const suggestions = searchActive ? (data?.items ?? []) : [];
  return (
    <div className="f" style={{ position: "relative" }}>
      <label htmlFor="wizard-landmark-input">Ориентир</label>
      <input
        id="wizard-landmark-input"
        className="txt"
        value={value}
        autoComplete="off"
        placeholder="Например: рядом с ТЦ Садбарг"
        aria-label="Ориентир"
        data-testid="wizard-landmark-input"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        // Задержка перед закрытием — клик по подсказке (onMouseDown) должен успеть
        // сработать раньше, чем blur закроет список (тот же приём, что у адреса выше).
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {auto && (
        <p style={{ marginTop: 6, fontSize: 13, color: "var(--muted)" }} data-testid="wizard-landmark-auto">
          Подобрано по точке на карте, можно поправить
        </p>
      )}
      {open && suggestions.length > 0 && (
        <div className="sugg" role="listbox" aria-label="Подсказки ориентира" data-testid="wizard-landmark-suggestions">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s.name);
                setOpen(false);
              }}
            >
              <span className="nm">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Список подсказок адреса — облик `.sugg`/`.tag`/`.nm`/`.rg` из артефакта,
 *  данные настоящие (`GET /geo/resolve`): пусто — честное «нет в справочнике». */
function AddressSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: GeoResolveCandidate[];
  onPick: (s: GeoResolveCandidate) => void;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="sugg">
        <div className="empty">Нет в справочнике — сохраним ваш вариант</div>
      </div>
    );
  }
  return (
    <div className="sugg" role="listbox" aria-label="Подсказки адреса" data-testid="wizard-address-suggestions">
      {suggestions.map((s) => (
        <button
          key={`${s.targetType}-${s.targetId}`}
          type="button"
          role="option"
          // onMouseDown, не onClick: срабатывает раньше blur поля,
          // иначе onBlur успевает закрыть список первым.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(s);
          }}
        >
          <span className="tag">{TARGET_TYPE_LABEL[s.targetType]}</span>
          <span className="nm">{s.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Подпись типа подсказки адреса — та же вкладка, что показывает `PropertiesMap.tsx`. */
const TARGET_TYPE_LABEL: Record<GeoResolveCandidate["targetType"], string> = {
  building: "дом",
  street: "улица",
  microdistrict: "мкр",
  livingArea: "жилой массив",
  landmark: "ориентир",
  district: "район",
};

/**
 * Район по ответу геокодера, иначе — по ближайшему центру района.
 *
 * Название сравнивается без «район/ноҳияи» и без разницы в написании: OSM
 * отдаёт то «Сино», то «район Сино», то «Sino», то «ноҳияи Шоҳмансур». Ближайший центр — грубая, но честная подсказка:
 * четыре района Душанбе крупные, и промах виден агенту сразу, а исправляется
 * одной кнопкой.
 */
function pickDistrict(
  districts: District[],
  osmName: string | null,
  point: { lat: number; lng: number } | null
): District | null {
  if (osmName) {
    const byName = districts.find((d) => isSameDistrictName(osmName, d.name));
    if (byName) return byName;
  }
  if (!point) return null;
  let best: { district: District; distance: number } | null = null;
  for (const d of districts) {
    const center = DISTRICT_COORDS[d.name];
    if (!center) continue;
    const distance = (center[0] - point.lat) ** 2 + (center[1] - point.lng) ** 2;
    if (!best || distance < best.distance) best = { district: d, distance };
  }
  return best?.district ?? null;
}

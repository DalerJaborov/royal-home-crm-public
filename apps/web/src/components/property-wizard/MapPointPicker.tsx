import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { CITY_CENTER } from "../../lib/districtCoords";
import { snapNote, fetchHouseSnap } from "../../lib/houseSnap";
import { attachYandexFallback, primaryTileConfig } from "../../lib/leafletYandexTiles";

/**
 * ВЫБОР ТОЧКИ КАК В ТАКСИ: метка прибита к центру экрана, двигается карта.
 *
 * Почему не перетаскиваемая метка (как в LocationPicker на карточке объекта):
 * палец закрывает собой ровно ту точку, которую ставит, и на телефоне попасть
 * в подъезд получается со второй-третьей попытки. Центральная метка всегда
 * видна, а точность задаётся масштабом, а не меткостью пальца.
 *
 * Геопозиция САМА не запрашивается (снято 17.09.2026 — см. комментарий у
 * эффекта ниже). Карта открывается на центре Душанбе (или на переданном
 * центре района), точка — через поиск по адресу, движение карты руками, или
 * кнопку «Определить мою позицию» по явному тапу.
 */

/** Хуже этой точности (метры) — не приближаем до упора, а показываем разброс. */
const ACCURACY_OK_M = 50;

type GeoState =
  | "idle"
  | "locating"
  | "ok"
  | "denied"
  | "unavailable"
  | "timeout"
  | "unsupported"
  | "insecure";

/** Браузер физически не сможет определить позицию — не пытаемся, говорим прямо. */
function detectGeoBlocked(): "unsupported" | "insecure" | null {
  if (typeof navigator === "undefined" || !navigator.geolocation) return "unsupported";
  // Geolocation работает только в защищённом контексте (HTTPS), кроме localhost.
  // В http эта проверка отсекает молчаливый отказ ДО вызова API — иначе агент
  // видит общее «не удалось» и не понимает, что дело в протоколе сайта.
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
  return null;
}

function geoErrorState(err: GeolocationPositionError): GeoState {
  if (err.code === err.PERMISSION_DENIED) return "denied";
  if (err.code === err.TIMEOUT) return "timeout";
  return "unavailable"; // POSITION_UNAVAILABLE и прочее — сигнал недоступен
}

function geoMessage(state: GeoState, accuracy: number | null): string {
  switch (state) {
    case "locating":
      return "Определяю, где вы стоите…";
    case "ok":
      return accuracy !== null && accuracy > ACCURACY_OK_M
        ? `Определено с точностью около ${Math.round(accuracy)} м — проверьте метку и поправьте картой.`
        : "Метка на вашей точке. Двигайте карту, чтобы поправить — метка всегда в центре.";
    case "denied":
      return "Доступ к геопозиции запрещён браузером. Разрешите его в настройках сайта или двигайте карту руками — метка всегда в центре.";
    case "unavailable":
      return "Не удалось определить позицию — сигнал недоступен. Двигайте карту руками — метка всегда в центре.";
    case "timeout":
      return "Определение позиции заняло слишком много времени. Попробуйте ещё раз или двигайте карту руками.";
    case "unsupported":
      return "Этот браузер не умеет определять геопозицию. Двигайте карту руками — метка всегда в центре.";
    case "insecure":
      return "Геопозиция работает только по защищённому соединению (HTTPS). Двигайте карту руками — метка всегда в центре.";
    default:
      return "Двигайте карту — метка всегда в центре экрана.";
  }
}

export function MapPointPicker({
  value,
  fallbackCenter,
  onChange,
  onLocating,
  note,
}: {
  value: { lat: number; lng: number } | null;
  /** Строка под картой от шага — например, «точку по фото поставили на дом …». */
  note?: string | null;
  /** Куда смотреть, пока точки нет и геопозиция недоступна. */
  fallbackCenter?: [number, number];
  onChange: (coords: { lat: number; lng: number }) => void;
  /** Сообщает шагу, что карту двигают — чтобы не показывать устаревший адрес. */
  onLocating?: (moving: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const accuracyCircleRef = useRef<L.Circle | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLocatingRef = useRef(onLocating);
  onLocatingRef.current = onLocating;
  // Первая точка приходит из value/геопозиции — читаем её через ref, чтобы
  // карта не пересоздавалась при каждом изменении координат родителем.
  const initialRef = useRef(value);
  const fallbackRef = useRef(fallbackCenter);
  fallbackRef.current = fallbackCenter;
  // Компонент мог размонтироваться раньше, чем придёт геопозиция — тогда
  // setState после ответа уронил бы предупреждение React в консоль.
  const mountedRef = useRef(true);

  // Карта готова сообщать координаты наружу только после того, как прошла
  // invalidateSize()+первый кадр (иначе стартовый resize может сам поднять
  // moveend и наружу уйдёт центр города, которого агент не выбирал), И только
  // для сдвига, у которого есть причина: живой жест (dragstart/zoomstart) или
  // наш собственный намеренный setView (геопозиция, кнопка «Определить»).
  // Без этой пары флагов «карта готова» и «сдвиг настоящий» — оба нужны, по
  // отдельности каждый пропускает свой случай ложного срабатывания.
  const readyRef = useRef(false);
  const userMoveRef = useRef(false);
  // Сдвиг за адресом от родителя (эффект ниже): его zoomstart — не жест агента,
  // и наружу такой сдвиг не сообщаем (23.09.2026, аудит к стабильной версии).
  const followingValueRef = useRef(false);

  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  // «Определить мою позицию» поставило метку на дом рядом — пишем, на какой.
  // Гаснет, как только агент сам тронет карту.
  const [phoneNote, setPhoneNote] = useState<string | null>(null);
  const draggedRef = useRef(0);
  const [mapOffline, setMapOffline] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start = initialRef.current ?? {
      lat: (fallbackRef.current ?? CITY_CENTER)[0],
      lng: (fallbackRef.current ?? CITY_CENTER)[1],
    };
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true }).setView(
      [start.lat, start.lng],
      initialRef.current ? 17 : 14
    );
    const tileConfig = primaryTileConfig();
    const tileLayer = L.tileLayer(tileConfig.url, {
      attribution: tileConfig.attribution,
      maxZoom: 19,
    }).addTo(map);
    tileLayerRef.current = tileLayer;
    // Отказ Яндекса откатывает на OSM молча (см. leafletYandexTiles.ts); тайлы
    // не загрузились и там (сеть легла) — карта остаётся серой молча, а агент
    // должен понять, почему, и что это не ошибка мастера.
    attachYandexFallback(tileLayer, tileConfig, () => setMapOffline(true));
    tileLayer.on("load", () => setMapOffline(false));

    // dragstart бывает только от настоящего жеста (палец/мышь) — в отличие
    // от zoomstart он никогда не приходит от нашего же setView/fitBounds,
    // поэтому именно по нему безопасно гасить круг точности: масштаб сам по
    // себе не двигает центр (метка «как в такси» стоит на месте экрана), а
    // вот перетаскивание меняет координату под меткой и делает круг неверным.
    map.on("dragstart", () => {
      userMoveRef.current = true;
      draggedRef.current += 1;
      setPhoneNote(null);
      if (accuracyCircleRef.current) {
        accuracyCircleRef.current.remove();
        accuracyCircleRef.current = null;
      }
    });
    map.on("zoomstart", () => {
      if (followingValueRef.current) return;
      userMoveRef.current = true;
    });

    map.on("movestart", () => onLocatingRef.current?.(true));
    map.on("moveend", () => {
      onLocatingRef.current?.(false);
      followingValueRef.current = false;
      if (!readyRef.current || !userMoveRef.current) return;
      userMoveRef.current = false;
      const c = map.getCenter();
      onChangeRef.current({ lat: c.lat, lng: c.lng });
    });

    mapRef.current = map;
    // Контейнер получает высоту после первого кадра — без пересчёта Leaflet
    // рисует карту в нулевом размере и остаётся серым прямоугольником.
    const resize = setTimeout(() => {
      map.invalidateSize();
      requestAnimationFrame(() => {
        readyRef.current = true;
        // Тестам нужно на что-то ждать, прежде чем читать координаты/жесты.
        containerRef.current?.setAttribute("data-map-ready", "true");
      });
    }, 0);

    return () => {
      clearTimeout(resize);
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      accuracyCircleRef.current = null;
    };
  }, []);

  /**
   * КАРТА ИДЁТ ЗА АДРЕСОМ, ВЫБРАННЫМ В ПОДСКАЗКЕ (21.09.2026).
   *
   * Владелец: «карта не работает по поиску, я нажимаю адрес из подсказки, он
   * просто показывает адрес, но сама карта никуда не перемещается».
   *
   * Причина. Точка читалась ОДИН раз, на монтировании (`initialRef` выше) —
   * приём верный сам по себе: иначе карта пересоздавалась бы на каждое
   * движение центра, которое она же и породила. Но из-за него карта не видела
   * и координат, пришедших СНАРУЖИ: выбор подсказки (StepPlace.tsx кладёт
   * candidate.lat/lng в значения мастера) двигал только поле адреса. Хуже
   * того, первый же жест по карте отправлял наружу её прежний центр и стирал
   * координаты выбранного адреса.
   *
   * Наружу этот сдвиг НЕ сообщаем (`runProgrammaticMove` здесь не зовём):
   * координаты пришли от родителя, он их уже знает, а ответ ему же замкнул бы
   * круг «родитель → карта → родитель».
   *
   * Порог в ~1 метр (1e-5 градуса) отсекает дребезг: Leaflet возвращает центр
   * с точностью до долей метра, и точное сравнение двигало бы карту после
   * каждого собственного moveend.
   */
  const valueLat = value?.lat ?? null;
  const valueLng = value?.lng ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || valueLat === null || valueLng === null) return;
    const c = map.getCenter();
    if (Math.abs(c.lat - valueLat) < 1e-5 && Math.abs(c.lng - valueLng) < 1e-5) return;
    followingValueRef.current = true;
    map.setView([valueLat, valueLng], Math.max(map.getZoom(), 17));
  }, [valueLat, valueLng]);

  // Сеть пропала/вернулась — сообщаем прямо и сами перерисовываем тайлы,
  // когда связь появилась (Leaflet сам не заметит, что интернет вернулся).
  useEffect(() => {
    const handleOnline = () => {
      setMapOffline(false);
      tileLayerRef.current?.redraw();
    };
    const handleOffline = () => setMapOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  /**
   * Флаг «компонент ещё жив» — чтобы ответ геопозиции, пришедший после ухода со
   * шага, не дёргал setState.
   *
   * ПОДНИМАТЬ ЕГО ОБРАТНО В ТЕЛЕ ЭФФЕКТА ОБЯЗАТЕЛЬНО. В React 18 StrictMode
   * эффекты на монтировании прогоняются дважды: смонтировали → размонтировали →
   * смонтировали. Без строки ниже уборка первого прогона навсегда оставляла
   * флаг опущенным, и геопозиция переставала применяться вовсе: карта висела на
   * «Определяю, где вы стоите…» и не двигалась к точке агента. Поймано кадрами
   * шага «Где» (метка осталась в центре Душанбе при разрешённой геопозиции).
   */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Сдвиг карты нашим же кодом (геопозиция, кнопка «Определить») — не жест
  // агента, но сообщить наружу его так же можно и нужно: помечаем разрешённым
  // и заодно поднимаем readyRef на случай, если геопозиция пришла быстрее,
  // чем успел отработать invalidateSize (кэшированная позиция бывает почти
  // мгновенной).
  function runProgrammaticMove(fn: () => void) {
    readyRef.current = true;
    userMoveRef.current = true;
    fn();
  }

  function applyPosition(lat: number, lng: number, accuracyM: number) {
    if (!mountedRef.current) return;
    setGeoState("ok");
    setAccuracy(accuracyM);
    const map = mapRef.current;
    if (!map) return;
    accuracyCircleRef.current?.remove();
    accuracyCircleRef.current = null;
    runProgrammaticMove(() => {
      if (accuracyM > ACCURACY_OK_M) {
        // Точность плохая — не приближаем вслепую до 18-го зума, а показываем
        // разброс кругом и подбираем масштаб по его границам.
        const circle = L.circle([lat, lng], {
          radius: accuracyM,
          // Цвет литералом, а не токеном темы: Leaflet кладёт его в
          // презентационный атрибут SVG, а `var()` там разбирают не все
          // браузеры — круг молча стал бы чёрным. Тот же синий, что у метки
          // на карточке объекта (LocationPicker.pinIcon).
          color: "#2563eb",
          weight: 1,
          fillColor: "#2563eb",
          fillOpacity: 0.12,
          opacity: 0.45,
          interactive: false,
        }).addTo(map);
        accuracyCircleRef.current = circle;
        map.fitBounds(circle.getBounds(), { maxZoom: 18, padding: [24, 24] });
      } else {
        map.setView([lat, lng], 18);
      }
    });
    // Позиция телефона в доме почти всегда уходит на улицу — ставим метку на
    // дом рядом (lib/houseSnap.ts). Агент успел сам подвинуть карту —
    // его выбор главнее, ничего не переносим.
    // Точность хуже 50 м — на дом НЕ переносим (02.10.2026): при ±200 м ближайший
    // дом в 30 м от показанной точки — случайный, а метка и адрес с номером
    // встали бы на него. Показываем разброс кругом, выбор — за агентом.
    if (accuracyM > ACCURACY_OK_M) return;
    const draggedBefore = draggedRef.current;
    void fetchHouseSnap(lat, lng).then((snapped) => {
      if (!snapped || !mountedRef.current || draggedRef.current !== draggedBefore) return;
      const m = mapRef.current;
      if (!m) return;
      runProgrammaticMove(() => m.setView([snapped.lat, snapped.lng], Math.max(m.getZoom(), 18)));
      setPhoneNote(snapNote(snapped, "phone"));
    });
  }

  function requestPosition(maximumAge: number) {
    const blocked = detectGeoBlocked();
    if (blocked) {
      setGeoState(blocked);
      return;
    }
    setGeoState("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => applyPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      (err) => {
        if (!mountedRef.current) return;
        setGeoState(geoErrorState(err));
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge }
    );
  }

  /**
   * ГЕОПОЗИЦИЮ САМИ БОЛЬШЕ НЕ ЗАПРАШИВАЕМ (владелец 17.09.2026, живая жалоба).
   *
   * Было: открытие шага сразу спрашивало разрешение и молча ставило точку на
   * ТЕКУЩЕМ месте агента — даже когда в черновике уже лежат фото/видео объекта
   * (EXIF с них при отправке ставит правильную точку сам, см.
   * propertyPhotoGeo.ts) или агент физически не в квартире (снимает не на
   * месте, добавляет объект позже по памяти). Агент получал чужую точку без
   * единого клика и не сразу понимал, откуда она взялась.
   *
   * Стало: точка — только через поиск по адресу (.msearch на шаге) или
   * движением карты руками. Кнопка «Определить мою позицию» ниже осталась —
   * это по-прежнему рабочий способ для тех, кто СТОИТ у объекта и хочет точку
   * одним тапом, но теперь он запрашивается, а не навязывается.
   */

  return (
    <>
      <div
        style={{
          position: "relative",
          // z-index:0 — не декорация, а рамка стекинг-контекста (найдено
          // 17.09.2026, живая жалоба «не видно строки поиска»). Без него
          // position:relative ничего не огораживает: внутренняя панель
          // тайлов Leaflet (.leaflet-map-pane, z-index:400) вылезает НАРУЖУ
          // этого блока и перекрывает соседний `.msearch` (z-index:4) в
          // StepPlace.tsx — хотя тот и оставался кликабельным (фокус и ввод
          // работали программно), визуально он был погребён под картой.
          zIndex: 0,
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          border: "1px solid var(--line)",
          height: "clamp(300px, 52vh, 560px)",
        }}
      >
        <div ref={containerRef} data-testid="wizard-map" style={{ position: "absolute", inset: 0 }} />
        {/* Метка центра — поверх карты, но не перехватывает жесты. */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 26,
            height: 26,
            marginLeft: -13,
            marginTop: -26,
            borderRadius: "50% 50% 50% 0",
            rotate: "45deg",
            background: "var(--pill)",
            border: "2.5px solid var(--card)",
            boxShadow: "var(--shadow-pop)",
            pointerEvents: "none",
            zIndex: 500,
          }}
        />
      </div>

      {mapOffline && (
        <div className="quiet warn" role="alert" data-testid="wizard-map-offline">
          <span className="dot warn" aria-hidden />
          <span className="txt">
            Карта не загрузилась — нет сети. Адрес и район можно указать руками, точка на карте не обязательна.
          </span>
        </div>
      )}

      {/* flexWrap — не украшение: на 390 px кнопка «Определить мою позицию»
          отнимала у текста всю ширину, и строка состояния сжималась в колонку
          по одному слову (поймано кадром на 390). Переносим кнопку на свою
          строку, когда она не помещается рядом. */}
      <div
        className="quiet"
        role="status"
        data-testid="wizard-geo-status"
        style={{ flexWrap: "wrap", rowGap: 6 }}
      >
        <span
          className={
            geoState === "denied" ||
            geoState === "unavailable" ||
            geoState === "timeout" ||
            geoState === "unsupported" ||
            geoState === "insecure"
              ? "dot warn"
              : "dot"
          }
          aria-hidden
        />
        <span className="txt">{geoMessage(geoState, accuracy)}</span>
        <button
          className="lnk"
          type="button"
          aria-label="Определить мою позицию"
          data-testid="wizard-geo-retry"
          disabled={geoState === "locating"}
          onClick={() => requestPosition(0)}
        >
          {geoState === "idle" || geoState === "ok" ? "Определить мою позицию" : "Попробовать ещё раз"}
        </button>
      </div>
      {(phoneNote ?? note) && (
        <div className="quiet" role="status" data-testid="wizard-snap-note">
          <span className="dot" aria-hidden />
          <span className="txt">{phoneNote ?? note}</span>
        </div>
      )}
    </>
  );
}

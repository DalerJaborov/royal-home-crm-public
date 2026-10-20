import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMoney, formatPricePerSqm, pluralizeRu } from "../../lib/format";
import { dushanbeDate, dushanbeTime } from "../../lib/date";
import { plannedStatusLabel } from "../../lib/publishPlanned";
import { statusChipClass, statusChipLabel } from "../../lib/theme2026";
import type { Property, PropertyPhoto } from "../../types";
import { Rh2Inline } from "../rh2/Rh2Scope";
import { useGoBack } from "../../hooks/useGoBack";
import { PhotoLightbox } from "../PhotoLightbox";

/**
 * Мобильные блоки карточки объекта, тема «Royal Home 2026».
 *
 * Разметка и имена классов — из прототипа `docs/pult/theme-2026/screens/
 * property-detail.html` (`.pg-h`, `.gal`, `.money`, `.chip`, `.trio`, `.row`,
 * `.lnk`), поэтому блоки живут внутри `.rh2` карточки объекта и наследуют её
 * токены и ночную тему. Своих цветов и своих размеров шрифта здесь больше нет:
 * прежняя мобильная подача (плитки на сиреневой подложке, фирменные градиенты
 * Instagram и красный Яндекса) относилась к облику design_handoff, а он
 * заменён темой целиком.
 *
 * Отдельный файл сохранён не ради оформления, а ради поведения, которого в
 * прототипе нет: свайп по фотографиям с точками и прокрутка к блоку
 * «Фотографии». Данные приходят из той же карточки Property, что и на
 * десктопе, ничего не выдумывается.
 */

/**
 * Обёртка области эталона. Каждый блок открывает `.rh2` сам, а не полагается
 * на то, что вызывающий экран уже внутри неё: блок носит имена классов
 * прототипа (`.card`, `.row`, `.chip`), и вне области они не значат ничего —
 * элемент молча остаётся без оформления, ничего не падает и не предупреждает.
 * Вложенная `.rh2` внутри уже открытой безвредна: токены переопределяются теми
 * же значениями, а ночная тема приходит правилом `html[data-theme=…] .rh2`,
 * которое одинаково находит и внешнюю, и внутреннюю.
 */
function Rh2({ children }: { children: ReactNode }) {
  return <Rh2Inline>{children}</Rh2Inline>;
}

/** Шапка карточки: `.pg-h` эталона — ссылка «Объекты», заголовок, подпись
 *  и карандаш справа. Карандаш ведёт в форму параметров объекта (цена,
 *  площадь, адрес); фото, видео, описание и поля правятся на месте, кнопкой у
 *  своего блока (пункт 17 разбора, 24.09.2026). До этого карандаш открывал меню
 *  «Параметры / Фото, видео и описание», а второй пункт — отдельный режим правки
 *  этой же страницы, который рисовал ту же шапку заново, и нажатие выглядело
 *  так, будто ничего не произошло (жалоба владельца 21.09.2026). */
export function MobilePropertyHeader({
  title,
  subtitle,
  backTo,
  onEdit,
}: {
  title: string;
  subtitle: string;
  backTo: string;
  onEdit?: (() => void) | null;
}) {
  const goBack = useGoBack(backTo);
  return (
    <Rh2>
      <div className="pg-h">
      <div>
        {/* НАСТОЯЩАЯ ССЫЛКА, НО ШАГ НАЗАД ПО НАЖАТИЮ (21.09.2026). Владелец:
            «поработай отдельно над всеми кнопками „Назад“». Голая ссылка на
            `/properties` уводила в ЧИСТЫЙ список: терялись срез, страница и
            место, до которого долистали, — то есть каждый возврат из карточки
            начинался заново. Остаётся ссылкой (средний щелчок, «открыть в новой
            вкладке», адрес в строке браузера), а обычное нажатие
            перехватываем и делаем шаг назад; пришли по прямой ссылке — уходим
            по `backTo` (разбор в hooks/useGoBack.ts). */}
        <Link
          className="lnk"
          to={backTo}
          style={{ paddingLeft: 0 }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            goBack();
          }}
        >
          <svg className="i" viewBox="0 0 24 24" style={{ marginRight: 6 }}>
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Объекты
        </Link>
        <h1 style={{ marginTop: 4 }}>{title}</h1>
        {/* `keep`: на телефоне описание раздела под заголовком прячется, а здесь
            это адрес объекта — без него карточка не говорила, где квартира. */}
        <p className="sub keep">{subtitle}</p>
      </div>
      <div className="acts">
        {onEdit && (
          <button
            className="pill ghost"
            type="button"
            onClick={onEdit}
            aria-label="Изменить параметры объекта"
          >
            <svg className="i" viewBox="0 0 24 24">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Изменить
          </button>
        )}
        </div>
      </div>
    </Rh2>
  );
}

/**
 * Фото-лента карточки объекта на телефоне.
 *
 * Сетка `.gal` эталона на телефоне схлопывается в две колонки, но листать
 * снимки пальцем в ней нельзя, а на телефоне карточку смотрят именно так.
 * Поэтому здесь одна ячейка `.gal .cell.big` во всю ширину, внутри неё
 * горизонтальный scroll-snap по фотографиям.
 *
 * ПОЧЕМУ СЧЁТЧИК, А НЕ ТОЧКИ (21.09.2026, жалоба владельца «фото даже не
 * свайпаются»). Точек рисовалось не больше восьми — иначе при сорока снимках
 * ряд шире экрана, — и индекс зажимался тем же числом. С девятого кадра
 * подсветка переставала двигаться: лента листается, а признак листания стоит
 * на месте, и это читается ровно как «свайп не работает». Счётчик «3 из 12»
 * такого предела не имеет и заодно отвечает на вопрос «сколько всего».
 *
 * ПОЧЕМУ ОТКРЫВАЕТСЯ ВО ВЕСЬ ЭКРАН. Второе замечание того же дня — «фото
 * маленькие, надо прищуриваться». Полноэкранный просмотрщик в проекте уже
 * есть (components/PhotoLightbox.tsx: жест, счётчик, клавиатура, ловушка
 * фокуса) — карточка объекта просто им не пользовалась. Нажатие на кадр
 * открывает ЕГО ЖЕ, а не первый: индекс берём из текущего положения ленты.
 *
 * Кнопка-камера ведёт к блоку «Фотографии» ниже, где загрузка и порядок.
 * Сердечка из прежнего макета нет: избранного у объектов не существует,
 * мёртвую кнопку не рисуем.
 */
export function MobilePropertyHero({
  photos,
  onOpenPhotos,
}: {
  photos: PropertyPhoto[];
  onOpenPhotos?: (() => void) | null;
}) {
  const [idx, setIdx] = useState(0);
  // Индекс открытого во весь экран кадра; null — просмотрщик закрыт.
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  if (photos.length === 0) return null;
  const current = Math.min(idx, photos.length - 1);
  return (
    <Rh2>
      <div className="gal gal-hero">
      <div className="cell big" style={{ gridColumn: "span 2", position: "relative" }}>
        <div
          style={{ position: "absolute", inset: 0, display: "flex", overflowX: "auto", scrollSnapType: "x mandatory" }}
          onScroll={(e) => {
            const el = e.currentTarget;
            setIdx(Math.min(photos.length - 1, Math.round(el.scrollLeft / Math.max(1, el.clientWidth))));
          }}
        >
          {photos.map((ph, i) => (
            <button
              key={ph.id}
              type="button"
              onClick={() => setLightboxAt(i)}
              aria-label={`Открыть фото ${i + 1} из ${photos.length} во весь экран`}
              style={{
                width: "100%",
                height: "100%",
                flex: "none",
                scrollSnapAlign: "center",
                padding: 0,
                border: 0,
                background: "none",
                cursor: "zoom-in",
              }}
            >
              <img src={ph.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            </button>
          ))}
        </div>
        {onOpenPhotos && (
          // Раньше — голый значок-камера 44×42 без подписи (жалоба владельца
          // 21.09.2026 про мелкие кнопки-иконки на телефоне): непонятно, что
          // нажимать, и контраст плыл вместе со снимком под кнопкой. Подпись
          // «Фото» + тёмная полупрозрачная подложка — тот же приём, что уже
          // стоит у счётчика кадров рядом (`.gal-count`,
          // theme-2026-mobile-shell.css): фиксированный тёмный фон не тонет ни
          // в светлом, ни в тёмном снимке, токен темы здесь не подходит.
          <button
            className="pill ghost"
            type="button"
            onClick={onOpenPhotos}
            aria-label="К управлению фотографиями"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              height: 44,
              minHeight: 44,
              background: "rgba(0,0,0,.62)",
              color: "#fff",
              border: "none",
            }}
          >
            <svg className="i" viewBox="0 0 24 24">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            Фото
          </button>
        )}
        {photos.length > 1 && (
          <span className="gal-count" aria-hidden>
            {current + 1} из {photos.length}
          </span>
        )}
        </div>
      </div>
      {lightboxAt != null && (
        <PhotoLightbox
          photos={photos}
          index={lightboxAt}
          onClose={() => setLightboxAt(null)}
          onIndexChange={setLightboxAt}
        />
      )}
    </Rh2>
  );
}

/**
 * Цена: `.money.big` эталона, под ней цена метра и пилюли состояния. Свои
 * цвета пилюль отменены: состояние объекта красит `statusChipClass` — тот же
 * словарь, что и на десктопе и в списке объектов, один источник правды.
 */
export function MobilePriceCard({ property: p, canSeeMatch = false }: { property: Property; /** Число уже показывает строка «N покупателей ждут…» — чип не дублируем. */ canSeeMatch?: boolean }) {
  return (
    <Rh2>
      <div className="card tight">
      <div className="wrap" style={{ justifyContent: "space-between" }}>
        <span className="money big">{formatMoney(p.price, p.currency)}</span>
        <span style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>
          {formatPricePerSqm(p.price, p.areaSqm, p.currency)}
        </span>
      </div>
      <div className="wrap" style={{ marginTop: 10 }}>
        <span className={statusChipClass(p.status, p.pipeline)}>{plannedStatusLabel(p, Date.now(), dushanbeTime) ?? statusChipLabel(p.status, p.pipeline)}</span>
        <span className="chip mute">{p.publishedOnSite ? "Опубликован на сайте" : "На сайте не опубликован"}</span>
        {/* Дата приёма (эталон, tpl-property-detail: «Принят 2 сентября») — та же
            честная строка, что и на широком экране (см. PropertyDetail.tsx).
            listingAcceptedAt, а не createdAt (24.09.2026): в правке меняют именно
            «Дату принятия объекта», и чип обязан меняться вместе с ней. */}
        <span className="chip mute">Принят {dushanbeDate(p.listingAcceptedAt ?? p.createdAt, { day: "numeric", month: "long" })}</span>
        {p.viewsCount > 0 && (
          <span className="chip">
            {p.viewsCount} {pluralizeRu(p.viewsCount, ["показ", "показа", "показов"])}
          </span>
        )}
        {!!p.demandCount && !canSeeMatch && (
          <span className="chip">
            Ждут {p.demandCount} {pluralizeRu(p.demandCount, ["покупатель", "покупателя", "покупателей"])}
          </span>
        )}
        </div>
      </div>
    </Rh2>
  );
}

/**
 * Цифры объекта: ряд `.trio` эталона, в каждой ячейке `.n` со значением
 * крупно и подписью серым. Ряд целиком, а не отдельная плитка: `.trio` это
 * grid, и обёртка вокруг одной ячейки сломала бы раскладку.
 */
export function MobileParamTiles({ items }: { items: { label: string; value: string }[] }) {
  return (
    <Rh2>
      {/* `.params` — две колонки на телефоне (theme-2026-property-card.css):
          в три колонки «Хорошее состояние» рвалось посреди слова. */}
      <div className="trio params">
        {items.map((it) => (
          <div className="n" key={it.label}>
            <b style={{ fontSize: "var(--fs-17)" }}>{it.value}</b>
            <span>{it.label}</span>
          </div>
        ))}
      </div>
    </Rh2>
  );
}

/**
 * Ссылки наружу: строки `.row` эталона со ссылкой-именем и переходом справа.
 * Фирменные градиент Instagram и красный Яндекса убраны сознательно: §3
 * договора дизайна запрещает цветные иконки, цвет только `--ink`/`--muted`.
 * Подписью у карт стоит адрес объекта: на мобильной карточке его больше негде
 * показать, а он обязателен.
 */
export function MobileLinkButtons({ instagramUrl }: { instagramUrl: string | null }) {
  // Ссылка «открыть на Яндекс.Картах» отсюда убрана (решение владельца
  // 11.09.2026): точку объекта CRM хранит сама, показывает своей картой на
  // OpenStreetMap, и уводить агента в чужое приложение незачем. Кроме
  // Instagram показывать здесь нечего — пустая карточка со списком из нуля
  // строк выглядит поломкой, поэтому её просто нет.
  if (!instagramUrl) return null;
  return (
    <Rh2>
      <div className="card tight">
      <div className="list">
        {instagramUrl && (
          <div className="row">
            <span className="thumb">
              <svg className="i" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4" />
                <circle cx="17.5" cy="6.5" r="1" />
              </svg>
            </span>
            <div className="t">
              <b>Instagram</b>
              <span>Пост объекта</span>
            </div>
            <div className="act">
              <a className="lnk" href={instagramUrl} target="_blank" rel="noreferrer">
                Открыть
              </a>
            </div>
          </div>
        )}
        </div>
      </div>
    </Rh2>
  );
}

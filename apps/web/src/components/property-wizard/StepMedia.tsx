import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Check, Clock, Film, Image as ImageIcon, Loader2, Plus, RotateCw, Upload, X } from "lucide-react";
import { formatUploadSize } from "../UploadTaskRow";
import {
  addDraftPhotos,
  addDraftVideos,
  canRetryDraftItem,
  removeDraftMedia,
  replaceLostDraftFile,
  retryDraftMedia,
  type DraftMediaItem,
} from "../../lib/draftUploads";
import { MAX_DRAFT_PHOTOS, MAX_DRAFT_VIDEOS, screenPickedVideos } from "./media";

/**
 * ШАГ 1 — ФОТО И ВИДЕО. Облик — зона-кнопка по макету владельца, вариант А
 * (21.09.2026): большая зона «Добавить из галереи» во всю ширину вместо пары
 * кнопок в шапке блока; после первых снимков она сворачивается в плитку
 * «+ Добавить», последнюю в сетке того же размера, что снимок (сетка не
 * прыгает). У видео — такая же зона поменьше, а когда ролики уже есть —
 * полоса «+ Добавить ещё видео» во всю ширину под списком (это кусок
 * «варианта Б» макета: у списка роликов, в отличие от плиток фото, нет места
 * под ещё одну такую же плитку). Классы `.drop`, `.tile.add` (переопределён),
 * `.more`, `.tiles` (3 в ряд вместо 4) — в theme-2026-wizard-shell.css, файл
 * theme-2026-wizard.css генерируется скриптом и руками не трогается (шапка
 * того файла).
 *
 * КНОПКИ «СНЯТЬ» БОЛЬШЕ НЕТ (решение владельца 21.09.2026, везде только из
 * галереи) — поле с `capture="environment"` и вторая кнопка в шапке блока
 * убраны совсем. Снимать по-прежнему можно, просто заранее камерой телефона,
 * а сюда — выбирать уже снятое.
 *
 * ПЕРЕТАСКИВАНИЕ НА КОМПЬЮТЕРЕ (макет, «на компьютере — то же, плюс
 * перетаскивание»): зона, плитка «+» и полоса «Добавить ещё видео» принимают
 * drop, фото-зона берёт только image/*, видео — только video/*, остальное
 * молча отбрасывает (см. useFileDrop ниже). Текст зоны меняется по
 * `hover:hover and pointer:fine` — сенсорный экран видит «из галереи»,
 * широкий с мышью — подсказку про перетаскивание.
 *
 * Два РАЗНЫХ поля, а не одно на всё: до этой правки в карточку объекта можно
 * было положить только `image/*`, и видео обхода квартиры телефон в диалоге
 * выбора просто не показывал. Владелец считал это багом — и был прав.
 *
 * ФАЙЛ УХОДИТ СРАЗУ (11.09.2026, владелец: «прогресс фото и видео чтобы сразу
 * всё было видно»). Каждый файл тут же становится плиткой с полосой и
 * состоянием, а отдача идёт в черновик объекта параллельно заполнению
 * остальных шагов (lib/draftUploads.ts). Ничего не ждёт конца мастера.
 *
 * ПРОГРЕСС ТИШЕ (владелец 12.09.2026: «не нравится анимация и цвет» у зелёной
 * полосы и вечного слова «Готово»). На время загрузки — тонкое кольцо `.ring`
 * на плитке; на готовности — короткая галочка `.tick.blip`, которая гаснет
 * сама (keyframe `blip` из темы). Состояния отказа/обрыва — ИСКЛЮЧЕНИЕ: полоса
 * и текст ошибки остаются навсегда, пока агент не повторит или не уберёт
 * снимок — прятать их нельзя (не то же самое, что просто прогресс), поэтому
 * для них своя разметка вне классов артефакта (у него готового провала нет).
 *
 * ОБЛОЖКУ ВЫБИРАЕТ АГЕНТ, А НЕ ПОРЯДОК ЗАГРУЗКИ (владелец 12.09.2026). Тап по
 * любой плитке делает её обложкой (`onSetCover`). Порядок самих плиток в сетке
 * не трогаем — это порядок отдачи в draftUploads.ts (трогать нельзя). Итоговый
 * порядок фото у объекта (обложка — первым) решает сервер по `coverUploadKey`,
 * который мастер отправляет вместе с POST /properties (см. PropertyWizard.tsx).
 */
export function StepMedia({
  photos,
  videos,
  coverUploadKey,
  onSetCover,
  offSite,
}: {
  photos: DraftMediaItem[];
  videos: DraftMediaItem[];
  /** Ключ снимка-обложки — null, пока фото нет вовсе. */
  coverUploadKey: string | null;
  onSetCover: (uploadKey: string) => void;
  /** «Только для своих клиентов» — от этого зависит судьба первого ролика. */
  offSite: boolean;
}) {
  const galleryInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [videoNote, setVideoNote] = useState<string | null>(null);

  function addPhotos(list: FileList | File[] | null, input?: HTMLInputElement | null) {
    // Файлы забираем ДО очистки поля: `value = ""` обнуляет и сам FileList.
    const picked = list ? Array.from(list) : [];
    if (input) input.value = "";
    if (picked.length > 0) addDraftPhotos(picked);
  }

  /**
   * Размер проверяем СРАЗУ, а не после загрузки: ролик тяжелее общего предела
   * сервер отвергает ещё до первого байта. Подходящие уходят в очередь, тяжёлые
   * — заметкой с именем (по перетаскиванию путь тот же: useFileDrop ниже).
   */
  function addVideos(list: FileList | File[] | null) {
    const picked = list ? Array.from(list) : [];
    if (videoInput.current) videoInput.current.value = "";
    if (picked.length === 0) return;
    const { accepted, note } = screenPickedVideos(picked);
    setVideoNote(note);
    if (accepted.length > 0) addDraftVideos(accepted);
  }

  const photoDrop = useFileDrop("image", (files) => addPhotos(files));
  const videoDrop = useFileDrop("video", (files) => addVideos(files));

  return (
    <>
      <section className="blk">
        <div className="head">
          <h4>Фото</h4>
          <small className="sub">{photoHeaderCount(photos)}</small>
        </div>

        <input
          ref={galleryInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="wizard-photo-input"
          onChange={(e) => addPhotos(e.target.files, galleryInput.current)}
        />

        {photos.length === 0 ? (
          <button
            className={photoDrop.dragActive ? "drop drag" : "drop"}
            type="button"
            aria-label="Добавить фото из галереи"
            onClick={() => galleryInput.current?.click()}
            onDragEnter={photoDrop.onDragEnter}
            onDragOver={photoDrop.onDragOver}
            onDragLeave={photoDrop.onDragLeave}
            onDrop={photoDrop.onDrop}
          >
            <span className="ico">
              <ImageIcon width={24} height={24} aria-hidden />
            </span>
            <span className="t">
              <span className="only-touch">Добавить фото из галереи</span>
              <span className="only-desktop">Перетащите фото сюда</span>
            </span>
          </button>
        ) : (
          <div className="tiles" data-testid="wizard-photo-grid">
            {photos.map((item, i) => (
              <PhotoTile
                key={item.uploadKey}
                item={item}
                index={i}
                isCover={item.uploadKey === coverUploadKey}
                onSetCover={onSetCover}
              />
            ))}
            <button
              className={photoDrop.dragActive ? "tile add drag" : "tile add"}
              type="button"
              aria-label="Добавить ещё фото"
              onClick={() => galleryInput.current?.click()}
              onDragEnter={photoDrop.onDragEnter}
              onDragOver={photoDrop.onDragOver}
              onDragLeave={photoDrop.onDragLeave}
              onDrop={photoDrop.onDrop}
            >
              <Plus width={20} height={20} aria-hidden />
              <span>Добавить</span>
            </button>
          </div>
        )}
      </section>

      <section className="blk">
        <div className="head">
          <h4>Видео</h4>
          {videos.length === 0 && <small className="sub">до {MAX_DRAFT_VIDEOS} роликов</small>}
        </div>

        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          multiple
          hidden
          data-testid="wizard-video-input"
          onChange={(e) => addVideos(e.target.files)}
        />

        {videoNote && (
          <p className="sub" role="status" style={{ color: "var(--warn)" }}>
            {videoNote}
          </p>
        )}

        {videos.length === 0 ? (
          <button
            className={videoDrop.dragActive ? "drop video drag" : "drop video"}
            type="button"
            aria-label="Добавить видео из галереи"
            onClick={() => videoInput.current?.click()}
            onDragEnter={videoDrop.onDragEnter}
            onDragOver={videoDrop.onDragOver}
            onDragLeave={videoDrop.onDragLeave}
            onDrop={videoDrop.onDrop}
          >
            <span className="ico">
              <Film width={24} height={24} aria-hidden />
            </span>
            <span className="t">
              <span className="only-touch">Добавить видео из галереи</span>
              <span className="only-desktop">Перетащите видео сюда</span>
            </span>
          </button>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="wizard-video-list">
              {videos.map((item, i) => (
                <VideoRow key={item.uploadKey} item={item} index={i} offSite={offSite} photos={photos} videos={videos} />
              ))}
            </div>
            <button
              className={videoDrop.dragActive ? "more drag" : "more"}
              type="button"
              aria-label="Добавить ещё видео"
              onClick={() => videoInput.current?.click()}
              onDragEnter={videoDrop.onDragEnter}
              onDragOver={videoDrop.onDragOver}
              onDragLeave={videoDrop.onDragLeave}
              onDrop={videoDrop.onDrop}
            >
              <Plus width={16} height={16} aria-hidden />
              <span>Добавить ещё видео</span>
            </button>
          </>
        )}
      </section>
    </>
  );
}

/** Число в шапке блока «Фото»: до первого снимка — предел черновика, потом —
 *  сколько ушло, а как только все на месте — просто итог (макет владельца). */
function photoHeaderCount(photos: DraftMediaItem[]): string {
  if (photos.length === 0) return `до ${MAX_DRAFT_PHOTOS} снимков`;
  const ready = photos.filter((p) => p.status === "ready").length;
  return ready === photos.length ? pluralizeSnimok(photos.length) : `${ready} из ${photos.length} ушли`;
}

function pluralizeSnimok(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} снимок`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} снимка`;
  return `${n} снимков`;
}

/**
 * Приём файлов перетаскиванием на компьютере — на телефоне `dragenter` не
 * стреляет вовсе, так что для сенсорных экранов это чистая надстройка,
 * ничего не отбирает у тапа по той же зоне. Общая логика на все четыре места,
 * куда можно перетащить (задание, пункт 5: не дублировать): большая зона
 * пустого блока, плитка «+ Добавить» в сетке фото, зона и полоса видео —
 * каждое просто передаёт сюда, что́ считать подходящим файлом и что делать
 * дальше. Счётчик вложенности (`depth`), а не голый boolean: вложенные
 * элементы зоны (иконка, подписи) тоже шлют свои `dragenter`/`dragleave`,
 * и без счётчика подсветка мигала бы при курсоре над текстом внутри зоны.
 * Чужой тип (видео над фото-зоной и наоборот) отбрасывается молча — задание,
 * пункт 5: обе зоны игнорируют лишнее без ошибки, потому что мастер уже
 * когда-то ругался за AI картинку не в тот шаг и это раздражало.
 */
function useFileDrop(kind: "image" | "video", onFiles: (files: File[]) => void) {
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);

  function matches(file: File): boolean {
    return kind === "image" ? file.type.startsWith("image/") : file.type.startsWith("video/");
  }

  function onDragEnter(e: DragEvent<HTMLButtonElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    depth.current += 1;
    setDragActive(true);
  }
  function onDragOver(e: DragEvent<HTMLButtonElement>) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  }
  function onDragLeave() {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  }
  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    depth.current = 0;
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files ?? []).filter(matches);
    if (dropped.length > 0) onFiles(dropped);
  }

  return { dragActive, onDragEnter, onDragOver, onDragLeave, onDrop };
}

/** Процент по файлу. У готового всегда 100 — даже если сервер принял меньше байт
 *  после сжатия, чем показывал прогресс исходника. */
function percentOf(item: DraftMediaItem): number {
  if (item.status === "ready") return 100;
  if (item.sizeBytes <= 0) return 0;
  return Math.min(99, Math.round((item.loaded / item.sizeBytes) * 100));
}

function statusText(item: DraftMediaItem): string {
  switch (item.status) {
    case "queued":
      return item.error ? `Повторю: ${item.error}` : "Ждёт очереди";
    case "uploading":
      return `Гружу ${percentOf(item)} %`;
    case "ready":
      return "Готово";
    case "lost":
      return item.error ?? "Загрузка прервалась";
    default:
      return item.error ?? "Не ушло";
  }
}

/**
 * Почему видео стоит в очереди — честно, а не просто «Ждёт очереди»
 * (задание, пункт 4: чип назначения не должен выглядеть статусом загрузки).
 * Очередь по-прежнему сначала отправляет ВСЕ фото (draftUploads.ts::run —
 * узкий мобильный канал: параллельно не быстрее, только всё ползёт сразу),
 * это решение не меняем — меняем только то, видно ли агенту, что происходит.
 */
function videoWaitReason(item: DraftMediaItem, photos: DraftMediaItem[], videos: DraftMediaItem[]): string {
  if (item.error) return `Повторю: ${item.error}`;
  const photosAhead = photos.filter((p) => p.status === "queued" || p.status === "uploading").length;
  if (photosAhead > 0) return `Ждёт: сначала уходят фото — осталось ${photosAhead}`;
  const active = videos.find((v) => v.status === "uploading" && v.uploadKey !== item.uploadKey);
  if (active) return `Ждёт: грузится «${active.name}»`;
  return "Ждёт очереди";
}

/** Кольцо загрузки — класс `.ring` темы (артефакт), заливка кругом на лету. */
function UploadRing({ percent }: { percent: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 18 18" aria-hidden>
      <circle className="bg" cx="9" cy="9" r={r} />
      <circle className="fg" cx="9" cy="9" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - percent / 100)} />
    </svg>
  );
}

/**
 * Полоса прогресса — общая разметка для отказавшей фото-плитки и для строки
 * видео при загрузке (задание, пункт 4: «вынеси в общий маленький компонент,
 * не дублируй»). Инлайн-стили, а не класс темы: theme-2026-wizard.css трогать
 * нельзя (комментарий в шапке файла), а готового класса под полосу там нет —
 * у отказа она уже была инлайн, здесь та же разметка, параметризована фоном
 * под тёмную подложку плитки (onDark) и обычную строку видео.
 */
function ProgressBar({ percent, tone, onDark }: { percent: number; tone: "acc" | "warn"; onDark?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        height: 3,
        borderRadius: 2,
        background: onDark ? "rgba(255,255,255,.28)" : "rgba(127,132,145,.25)",
      }}
    >
      <span
        style={{
          display: "block",
          height: 3,
          borderRadius: 2,
          width: `${percent}%`,
          background: tone === "warn" ? "var(--warn)" : "var(--acc)",
          transition: "width .2s linear",
        }}
      />
    </span>
  );
}

/**
 * «Выбрать файл заново» для потерянной плитки (07.10.2026): самого файла у
 * вкладки уже нет, повтор бессмыслен — открываем выбор файла и подменяем запись
 * (lib/draftUploads.ts::replaceLostDraftFile). Скрытое поле, как у зон добавления.
 */
function useReplacePicker(item: DraftMediaItem): { open: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept={item.kind === "video" ? "video/*" : "image/*"}
      hidden
      data-testid="wizard-lost-file-input"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) replaceLostDraftFile(item.uploadKey, file);
      }}
    />
  );
  return { open: () => ref.current?.click(), input };
}

function PhotoTile({
  item,
  index,
  isCover,
  onSetCover,
}: {
  item: DraftMediaItem;
  index: number;
  isCover: boolean;
  onSetCover: (uploadKey: string) => void;
}) {
  const percent = percentOf(item);
  const bad = item.status === "failed" || item.status === "lost";
  const ready = item.status === "ready";
  const picker = useReplacePicker(item);

  return (
    // Плитка сама — НЕ кнопка (21.09.2026): HTML не разрешает <button> внутри
    // <button>, а «Убрать»/«Повторить» обязаны быть настоящими кнопками (цель
    // ≥44px на телефоне, Enter/Space с клавиатуры) — раньше это были <span
    // role="button"> со stopPropagation. Тап по всей плитке по-прежнему ставит
    // обложку — через кнопку `.hit` на всю площадь, лежащую НИЖЕ «Повторить» и
    // «Убрать» в порядке разметки (без вложенности всплытие им и не грозит,
    // stopPropagation больше не нужен).
    <div className={isCover ? "tile cover" : "tile"} data-testid="wizard-photo-tile" data-upload-status={item.status}>
      <button
        type="button"
        className="hit"
        aria-pressed={isCover}
        aria-label={isCover ? `Фото ${index + 1} — обложка объекта` : `Сделать фото ${index + 1} обложкой`}
        onClick={() => onSetCover(item.uploadKey)}
      >
        {item.previewUrl || item.thumbUrl ? (
          <img className="im" src={item.previewUrl ?? item.thumbUrl ?? ""} alt="" style={{ objectFit: "cover", width: "100%", height: "100%" }} />
        ) : (
          <span className="im" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>
            <ImageIcon width={16} height={16} aria-hidden />
          </span>
        )}
        <span className="badge">Обложка</span>

        {bad ? (
          // ОТКАЗ/ОБРЫВ — БЕЗ ИЗМЕНЕНИЙ: полоса и подпись остаются навсегда,
          // пока агент не повторит или не уберёт снимок (владелец: прятать
          // нельзя — это не то же самое, что обычный прогресс). Артефакт такого
          // состояния не знает — своя разметка поверх темы.
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              padding: "4px 6px",
              fontSize: 13,
              lineHeight: 1.2,
              color: "#fff",
              background: "linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,0))",
            }}
          >
            <span style={{ display: "block", marginBottom: 3 }}>
              <ProgressBar percent={percent} tone="warn" onDark />
            </span>
            {statusText(item)}
          </span>
        ) : (
          <>
            <span className="vh" role="status">
              {statusText(item)}
            </span>
            {ready ? (
              <span className={"tick" + (isCover ? "" : " blip")}>
                <Check width={10} height={10} aria-hidden />
              </span>
            ) : (
              <UploadRing percent={percent} />
            )}
          </>
        )}
      </button>

      {/* «Повторить» — только там, где повтор может помочь (обрыв, сбой сервера).
          Лимит/тип файла повтором не лечатся — у такой плитки лишь «Убрать»;
          потерянный файл (lost) выбирается заново (07.10.2026). */}
      {bad && canRetryDraftItem(item) && (
        // По центру плитки, подальше от «Убрать» в углу (координатор
        // 21.09.2026: рядом вплотную — два маленьких прицела не разлепить).
        <button
          type="button"
          className="retry"
          aria-label={`Повторить загрузку снимка ${index + 1}`}
          data-testid="wizard-photo-retry"
          onClick={() => retryDraftMedia(item.uploadKey)}
        >
          <RotateCw width={16} height={16} aria-hidden />
        </button>
      )}
      {item.status === "lost" && (
        <button
          type="button"
          className="retry"
          aria-label={`Выбрать файл снимка ${index + 1} заново`}
          data-testid="wizard-photo-pick-again"
          onClick={picker.open}
        >
          <Upload width={16} height={16} aria-hidden />
        </button>
      )}
      {picker.input}
      <button
        type="button"
        className="x"
        aria-label={item.status === "uploading" ? `Отменить загрузку снимка ${index + 1}` : `Убрать снимок ${index + 1}`}
        data-testid="wizard-photo-remove"
        onClick={() => void removeDraftMedia(item.uploadKey)}
      >
        <X width={13} height={13} aria-hidden />
      </button>
    </div>
  );
}

function VideoRow({
  item,
  index,
  offSite,
  photos,
  videos,
}: {
  item: DraftMediaItem;
  index: number;
  offSite: boolean;
  photos: DraftMediaItem[];
  videos: DraftMediaItem[];
}) {
  const bad = item.status === "failed" || item.status === "lost";
  const uploading = item.status === "uploading";
  const percent = percentOf(item);
  const picker = useReplacePicker(item);
  // ГЛАВНОЕ — СТАТУС ЗАГРУЗКИ, А НЕ ЧИП (задание, пункт 4: раньше при
  // «uploading» строка показывала только чип «Исходник монтажёру», и агент
  // видел его вместо честного прогресса — жалоба «видео не видно, что грузится»).
  const meta = uploading
    ? `${formatUploadSize(item.loaded)} из ${formatUploadSize(item.sizeBytes)} · ${percent}%`
    : item.status === "queued"
      ? videoWaitReason(item, photos, videos)
      : `${formatUploadSize(item.sizeBytes)} · ${statusText(item)}`;
  return (
    <div className="vrow" data-testid="wizard-video-row" data-upload-status={item.status}>
      <span className="ic">
        {item.status === "uploading" ? (
          <Loader2 width={16} height={16} aria-hidden />
        ) : item.status === "ready" ? (
          <Check width={16} height={16} aria-hidden />
        ) : item.status === "queued" ? (
          <Clock width={16} height={16} aria-hidden />
        ) : (
          <Film width={16} height={16} aria-hidden />
        )}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">{item.name}</div>
        <div className="mt">{meta}</div>
        {(uploading || bad) && (
          <div style={{ marginTop: 4 }}>
            <ProgressBar percent={percent} tone={bad ? "warn" : "acc"} />
          </div>
        )}
      </div>
      <span className={bad ? "chip warn" : offSite ? "chip ok" : "chip acc"} style={{ marginLeft: "auto" }}>
        {bad
          ? "не ушло"
          : index === 0
            ? offSite
              ? "Обзор клиенту"
              : "Исходник монтажёру"
            : "монтажёру"}
      </span>
      {bad && canRetryDraftItem(item) && (
        <button className="ghost" type="button" data-testid="wizard-video-retry" onClick={() => retryDraftMedia(item.uploadKey)}>
          Повторить
        </button>
      )}
      {item.status === "lost" && (
        <button className="ghost" type="button" data-testid="wizard-video-pick-again" onClick={picker.open}>
          Выбрать файл заново
        </button>
      )}
      {picker.input}
      <button className="ghost" type="button" data-testid="wizard-video-remove" onClick={() => void removeDraftMedia(item.uploadKey)}>
        {item.status === "uploading" ? "Отменить" : "Убрать"}
      </button>
    </div>
  );
}

import { useRef, useState } from "react";
import { DndContext, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, Check, Loader2, Sparkles, Star, Upload, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { PhotoLightbox } from "./PhotoLightbox";
import { draggableGroupProps } from "../lib/a11y";
import {
  downloadPropertyPhotosArchive,
  useApprovePhotoEnhance,
  useDeletePhoto,
  useEnhancePhoto,
  useRejectPhotoEnhance,
  useReorderPhotos,
} from "../hooks/useProperties";
import { useSettings } from "../hooks/useSettings";
import { compressImage } from "../lib/compressImage";
import { enqueuePhotos } from "../lib/uploadQueue";
import { UploadQueueList } from "./UploadQueueList";
import type { PropertyPhoto } from "../types";

/** Плитка фото: перетаскивается для смены порядка; клик (без движения) открывает
 * лайтбокс; звёздочка делает фото главным; крестик удаляет (с подтверждением).
 * Первое фото — обложка объекта. */
function SortablePhoto({
  photo,
  index,
  onOpen,
  onMakeMain,
  onDelete,
  onEnhance,
  enhancing,
  pendingReview,
}: {
  photo: { id: string; thumbUrl: string };
  index: number;
  onOpen: () => void;
  /** Не передан — режим просмотра: кнопка не рисуется. */
  onMakeMain?: () => void;
  onDelete?: () => void;
  /** Не передан — тумблер выключен или фото уже улучшается/ждёт решения:
   *  кнопка «Улучшить» не рисуется вовсе, а не рисуется отключённой. */
  onEnhance?: () => void;
  /** true — крутится спиннер именно на ЭТОЙ плитке (запрос ещё не ответил). */
  enhancing?: boolean;
  /** У фото уже есть неодобренный кандидат — карточка сравнения ниже, повторно
   *  запускать нечего, пока текущий результат не рассмотрен. */
  pendingReview?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id });
  return (
    /* Плитка `.pgrid .cell` эталона: снимок на всю ячейку, крестик справа
       сверху (`.x`, 44px на телефоне), подпись слева снизу (`.lead`).

       Роль плитки — `group`, а не `role="button"` (a11y, 10.09.2026): внутри
       стоят настоящие кнопки (сделать главным, удалить, улучшить), и роль
       кнопки прятала их от диктора целиком — axe `nested-interactive`. Кнопкой
       плитка и не работала: `<div role="button">` не отзывается на Enter без
       собственного обработчика, а его здесь нет, — открытие снимка как было
       мышью и пальцем, так и осталось. Разбор — lib/a11y.ts. */
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        backgroundImage: `url('${photo.thumbUrl}')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        cursor: "grab",
        touchAction: "none",
        userSelect: "none",
        opacity: isDragging ? 0.8 : undefined,
        zIndex: isDragging ? 10 : undefined,
        boxShadow: isDragging ? "0 0 0 2px var(--ink)" : undefined,
      }}
      {...draggableGroupProps(attributes)}
      {...listeners}
      onClick={onOpen}
      aria-label={`Фото ${index + 1}`}
      className="cell"
    >
      {index === 0 ? (
        <span className="lead">Главное</span>
      ) : onMakeMain ? (
        /* Звезда, а не подпись: в эталоне решение на плитке — иконка (кружок
           `.x`), длинный текст поверх снимка закрывал бы сам снимок. */
        <button
          className="x"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMakeMain();
          }}
          title="Сделать главным фото"
          aria-label="Сделать главным фото"
          style={{ right: "auto", left: 6, top: "auto", bottom: 6 }}
        >
          <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
            <path d="m12 3 2.7 5.6 6.3.9-4.5 4.3 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.5l6.3-.9z" />
          </svg>
        </button>
      ) : null}
      {onDelete && (
        <button
          className="x"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Удалить фото"
          aria-label="Удалить фото"
        >
          <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
      {pendingReview ? (
        <span className="lead" style={{ left: "auto", right: 6, bottom: 6 }}>
          На проверке
        </span>
      ) : onEnhance ? (
        <button
          className="x"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEnhance();
          }}
          disabled={enhancing}
          title="Улучшить фото: свет и резкость, результат ждёт вашего одобрения"
          aria-label="Улучшить фото"
          style={{ top: "auto", bottom: 6, opacity: enhancing ? 0.6 : undefined }}
        >
          <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
            <path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Карточка сравнения «было/стало» для одного неодобренного кандидата
 * улучшения — владелец 23.08.2026: до одобрения результат никто не видит
 * (не в каталоге, не на сайте), кнопки одобрить/отклонить решают его судьбу
 * тут же. Оригинал (thumbUrl) всегда рядом, а не заменяется молча.
 */
function PhotoEnhanceReviewCard({
  photo,
  onApprove,
  onReject,
  approving,
  rejecting,
}: {
  photo: PropertyPhoto;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
}) {
  const busy = approving || rejecting;
  return (
    /* Сравнение «было/стало» — строка решения `.mod.solve` эталона: слева
       два снимка сеткой `.pgrid`, справа решение двумя кнопками. */
    <div className="mod solve">
      <div className="t">
        <b>Улучшение фото</b>
        <span>Слева оригинал, справа кандидат. До одобрения его не видит никто, кроме вас.</span>
        <div className="pgrid" style={{ marginTop: 10, gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <div
            className="cell"
            style={{ backgroundImage: `url('${photo.thumbUrl}')`, backgroundSize: "cover", backgroundPosition: "center" }}
          >
            <span className="lead">Было</span>
          </div>
          <div
            className="cell"
            style={{
              backgroundImage: `url('${photo.enhancedThumbUrl}')`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }}
          >
            <span className="lead">Стало</span>
          </div>
        </div>
      </div>
      <div className="acts">
        <button className="pill ghost sm" type="button" onClick={onApprove} disabled={busy}>
          {approving ? "Принимаем…" : "Принять"}
        </button>
        <button className="lnk" type="button" onClick={onReject} disabled={busy}>
          {rejecting ? "Отклоняем…" : "Отклонить"}
        </button>
      </div>
    </div>
  );
}

/** Управление уже загруженными фото объекта: просмотр, загрузка новых, смена
 * порядка (drag-and-drop), выбор главного фото, удаление. Общий блок для
 * страницы объекта и полной формы редактирования (`/properties/:id/edit`) —
 * до этого форма редактирования не показывала существующие фото вовсе. */
export function PropertyPhotoManager({
  propertyId,
  shortId,
  photos,
  readOnly = false,
  embedded = false,
}: {
  propertyId: string;
  /** Числовой id объекта — только для имени файла ZIP-архива. */
  shortId?: number;
  photos: PropertyPhoto[];
  /**
   * false — редактирование доступно. Иначе — только просмотр, и значение само
   * называет причину: "trashed" (объект в корзине), "locked" (фото не открыты
   * кнопкой «Изменить фото») или "view" (у сотрудника нет права менять объект). Одно значение-причина, а не readOnly-булев плюс
   * второй пропс с причиной — раньше подпись ниже объясняла ТОЛЬКО «в корзине»,
   * даже когда объект был просто не в режиме редактирования (находка 12.09.2026:
   * агент открыл свой только что созданный объект и прочитал «в корзине»).
   */
  readOnly?: false | "trashed" | "locked" | "view";
  /** Блок уже стоит внутри чужой карточки `.card` со своим заголовком
   *  «Фотографии» (форма объекта, PropertyFormModal): свою карточку и свой
   *  заголовок не рисуем — иначе получаются карточка в карточке и два
   *  одинаковых заголовка подряд. */
  embedded?: boolean;
}) {
  const reorderPhotos = useReorderPhotos(propertyId);
  const deletePhoto = useDeletePhoto(propertyId);
  const enhancePhoto = useEnhancePhoto(propertyId);
  const approveEnhance = useApprovePhotoEnhance(propertyId);
  const rejectEnhance = useRejectPhotoEnhance(propertyId);
  // Рубильник Настроек → ИИ (Settings.propertyPhotoEnhanceEnabled). Читает и
  // рядовой сотрудник (toStaffSettings уже отдаёт это поле) — иначе кнопка
  // была бы видна только директору, хотя фото ведёт агент.
  const { data: settings } = useSettings();
  const [deletePhotoId, setDeletePhotoId] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  /** id фото, для которого сейчас летит запрос улучшения — спиннер только на
   *  этой плитке, остальные плитки не блокируются. */
  const [enhancingPhotoId, setEnhancingPhotoId] = useState<string | null>(null);
  /** Идёт сжатие перед постановкой в очередь — не отправка. */
  const [preparing, setPreparing] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Дистанция активации 8px отделяет перетаскивание от обычного клика по фото
  // (клик по-прежнему открывает лайтбокс, без неё drag съедал каждый тап).
  const photoSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  /**
   * Файлы уходят не отсюда, а через очередь (lib/uploadQueue.ts).
   *
   * Раньше отправка жила прямо в этой функции, и на обрыве связи мутация падала
   * вместе с выбором: агент заново лез в галерею и заново отмечал тридцать
   * снимков. Теперь пачки ложатся в хранилище устройства и уходят сами — экран
   * можно закрыть, вкладку перезагрузить, связь потерять.
   *
   * Здесь остаётся только сжатие (HEIC с iPhone → JPEG) и постановка в очередь.
   * Оно небыстрое на десятке снимков, поэтому показываем «Готовим…» — иначе
   * между нажатием и появлением списка заданий ничего не происходит.
   */
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setPreparing(true);
    try {
      await enqueuePhotos(propertyId, Array.from(files), compressImage, shortId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Не удалось поставить фото в очередь загрузки");
    } finally {
      setPreparing(false);
      // Один и тот же файл можно выбрать повторно после ошибки — без сброса
      // значения input повторный выбор того же файла не вызывает onChange.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleDownloadArchive() {
    setArchiveError(null);
    setArchiving(true);
    try {
      await downloadPropertyPhotosArchive(propertyId, shortId ?? 0);
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Не удалось скачать архив");
    } finally {
      setArchiving(false);
    }
  }

  function handlePhotoDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = photos.map((p) => p.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    reorderPhotos.mutate(next);
  }

  function makeMainPhoto(photoId: string) {
    const rest = photos.map((p) => p.id).filter((pid) => pid !== photoId);
    reorderPhotos.mutate([photoId, ...rest]);
  }

  /** Отказ рисования — ожидаемый исход (перегрузка Google, нет ключа), не
   *  повод падать: сервер отвечает 502 с человеческой причиной (см.
   *  ai/photoEnhance.ts), она и показывается прямо здесь. */
  function handleEnhance(photoId: string) {
    setEnhanceError(null);
    setEnhancingPhotoId(photoId);
    enhancePhoto.mutate(photoId, {
      onError: (err) => setEnhanceError(err instanceof Error ? err.message : "Не удалось улучшить фото"),
      onSettled: () => setEnhancingPhotoId(null),
    });
  }

  // Кандидаты, ждущие решения — карточка сравнения показывается независимо от
  // текущего положения тумблера: данные важнее переключателя, иначе результат
  // застрял бы навсегда, стоит владельцу выключить рубильник обратно.
  const pendingEnhancements = photos.filter((p) => p.enhancedUrl && p.enhancedThumbUrl);

  return (
    /* Карточка эталона: `.sec-h` с действиями справа, сетка снимков `.pgrid`
       с плиткой `.add` в конце, пояснения и ошибки тихими строками `.quiet`. */
    <div className={embedded ? "" : "card"}>
      <div className="sec-h stack">
        {!embedded && <h2>Фотографии</h2>}
        {embedded && <span />}
        <div className="wrap">
          {photos.length > 0 && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={handleDownloadArchive}
              disabled={archiving}
              title="Скачать все фото одним архивом"
            >
              {archiving ? "Архивируем…" : "Скачать всё (.zip)"}
            </button>
          )}
          {!readOnly && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => fileInput.current?.click()}
              // Блокируем только на время сжатия: сама отправка идёт в очереди, и
              // ждать её, чтобы выбрать следующую пачку, незачем.
              disabled={preparing}
            >
              {preparing ? "Готовим…" : "Загрузить"}
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {preparing && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Готовим фотографии…</span>
        </div>
      )}
      <UploadQueueList propertyId={propertyId} kind="photo" />
      {[
        [uploadError, () => setUploadError(null)] as const,
        [archiveError, () => setArchiveError(null)] as const,
        [enhanceError, () => setEnhanceError(null)] as const,
      ].map(([message, clear], i) =>
        message ? (
          <div className="quiet crit" role="alert" key={i}>
            <span className="dot crit" />
            <span className="txt">{message}</span>
            <button className="lnk" type="button" onClick={clear}>
              Понятно
            </button>
          </div>
        ) : null
      )}
      {!readOnly &&
        pendingEnhancements.map((photo) => (
          <PhotoEnhanceReviewCard
            key={photo.id}
            photo={photo}
            approving={approveEnhance.isPending && approveEnhance.variables === photo.id}
            rejecting={rejectEnhance.isPending && rejectEnhance.variables === photo.id}
            onApprove={() => approveEnhance.mutate(photo.id)}
            onReject={() => rejectEnhance.mutate(photo.id)}
          />
        ))}
      {photos.length === 0 && readOnly ? (
        <div className="empty">
          <span className="ic">
            <svg className="i" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <circle cx="9" cy="10" r="2" />
              <path d="m5 18 5-5 4 4 2-2 3 3" />
            </svg>
          </span>
          <p>Фотографии пока не загружены.</p>
          <p className="sub">Пока их нет, объект на проверку не уйдёт.</p>
        </div>
      ) : (
        <>
          <DndContext sensors={photoSensors} onDragEnd={handlePhotoDragEnd}>
            <SortableContext items={photos.map((p) => p.id)} strategy={rectSortingStrategy}>
              <div className="pgrid">
                {photos.map((photo, i) => (
                  <SortablePhoto
                    key={photo.id}
                    photo={photo}
                    index={i}
                    onOpen={() => setLightboxIndex(i)}
                    onMakeMain={readOnly ? undefined : () => makeMainPhoto(photo.id)}
                    onDelete={readOnly ? undefined : () => setDeletePhotoId(photo.id)}
                    onEnhance={
                      readOnly || !settings?.propertyPhotoEnhanceEnabled || photo.enhancedUrl
                        ? undefined
                        : () => handleEnhance(photo.id)
                    }
                    enhancing={enhancingPhotoId === photo.id}
                    pendingReview={!!photo.enhancedUrl}
                  />
                ))}
                {!readOnly && (
                  <button className="add" type="button" onClick={() => fileInput.current?.click()} disabled={preparing}>
                    <svg className="i xl" viewBox="0 0 24 24">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Добавить фото
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              {readOnly === "trashed"
                ? "Объект в корзине: фотографии только для просмотра."
                : readOnly === "locked"
                ? "Менять фотографии — кнопкой «Изменить фото»."
                : readOnly === "view"
                ? "Фотографии только для просмотра."
                : "Перетащите фото, чтобы поменять порядок. «Сделать главным» ставит снимок первым, крестик убирает. Порядок уходит и на сайт."}
            </span>
          </div>
          {deletePhotoId && (
            <ConfirmDialog
              title="Удалить фото?"
              description="Фото удалится из объекта и с сайта. Отменить действие нельзя."
              confirmLabel="Удалить"
              danger
              onConfirm={() => {
                deletePhoto.mutate(deletePhotoId);
                setDeletePhotoId(null);
              }}
              onCancel={() => setDeletePhotoId(null)}
            />
          )}
        </>
      )}
      {lightboxIndex !== null && (
        <PhotoLightbox photos={photos} index={lightboxIndex} onClose={() => setLightboxIndex(null)} onIndexChange={setLightboxIndex} />
      )}
    </div>
  );
}

import { useRef, useState, type DragEvent } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { downloadPropertyVideosArchive, useDeleteVideo, useDownloadVideo, usePropertyVideos } from "../hooks/useProperties";
import { api } from "../lib/api";
import { partitionVideosByLimit, videoTooLargeMessage } from "@royal-home/shared";
import { enqueueVideos } from "../lib/uploadQueue";
import { UploadQueueList } from "./UploadQueueList";
import { VideoPlayerWithFallback } from "./VideoPlayerWithFallback";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
  return `${Math.round(bytes / (1024 * 1024))} МБ`;
}

/** «1:20» — минуты:секунды, без часов: сырые ролики агента 20-50 секунд (см.
 *  докстринг модели PropertyVideo), часам взяться неоткуда. */
function formatDuration(sec: number): string {
  const total = Math.round(sec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * На телефоне (особенно iPhone) обычная ссылка на видео открывает встроенный
 * плеер Safari — ролик проигрывается, но не сохраняется в Галерею/Фото:
 * жалоба владельца 17.08.2026 «скачивается а просто показывается». Прямого
 * способа записать файл в Фото из веб-страницы без участия пользователя не
 * существует — это защита самого iOS. Единственный путь «в один тап» — системное
 * меню «Поделиться» (Web Share API с файлом): в нём у видео есть пункт
 * «Сохранить видео», кладущий ролик прямо в Галерею.
 *
 * Первая версия качала Blob прямо с presigned-ссылки R2 — и не работала:
 * `fetch()` на чужой домен браузер режет без CORS, а настраивать CORS у
 * бакета можно только в дашборде Cloudflare (вне репозитория). Поэтому файл
 * качаем через СВОЙ сервер (/videos/:id/file, тем же приёмом, что и ZIP-архив
 * ниже) — свой origin, CORS не нужен вовсе.
 *
 * Если Web Share с файлами недоступен (десктоп, старый Android) — откатываемся
 * на прежнее поведение (открыть presigned-ссылку в новой вкладке).
 */
async function shareVideoToGallery(propertyId: string, videoId: string, filename: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.canShare || !navigator.share) return false;
  const blob = await api<Blob>(`/properties/${propertyId}/videos/${videoId}/file`, { responseType: "blob" });
  const file = new File([blob], filename, { type: blob.type || "video/mp4" });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    // Пользователь сам закрыл шторку «Поделиться» — это не отказ, открывать
    // ссылку вдобавок не нужно, файл уже был честно предложен к сохранению.
    if (err instanceof DOMException && err.name === "AbortError") return true;
    throw err;
  }
  return true;
}

/**
 * Сырое видео объекта — без монтажа, до ~20 роликов в 4K (владелец 05.08.2026).
 * Видно только тем, у кого canManageProperty на этот объект (сервер проверяет
 * то же самое на GET/POST/DELETE) — монтажёру, маркетингу, администратору,
 * создавшему агенту. Загрузка без сжатия на клиенте: монтаж делается позже
 * вне CRM, сжимать заранее значит портить материал для монтажёра.
 *
 * Прогресс загрузки — через XMLHttpRequest (useUploadVideos), архив-скачивание
 * одним ZIP — эндпоинт /videos/archive.zip (см. useProperties.ts).
 */
export function PropertyVideoManager({
  propertyId,
  shortId,
  readOnly = false,
  handoffStatus,
  onStartEdit,
  onDone,
  inPipeline = false,
}: {
  propertyId: string;
  /** Объект ещё в конвейере подготовки (`pipeline.inPipeline` с сервера): только
   *  тогда пустой блок обещает «объект остаётся в подготовке». */
  inPipeline?: boolean;
  /** Числовой id объекта — только для имени файла ZIP-архива. */
  shortId?: number;
  readOnly?: boolean;
  /**
   * Этап передачи ролика монтажёру (Property.videoHandoffStatus). Нужен
   * ТОЛЬКО чтобы не врать про ожидание: см. `handoffMoved` ниже.
   */
  handoffStatus?: "NONE" | "QUEUED" | "SENT_TO_EDITOR" | "RECEIVED" | null;
  /**
   * Правка на месте в карточке объекта (пункт 17 разбора, 24.09.2026): пока
   * блок только для просмотра, справа ссылка «Изменить исходники», а в правке —
   * «Готово». Кнопки живут здесь, а не у родителя: когда блоку нечего
   * показывать (ролик уже у монтажёра, `handoffMoved`), он не рисуется целиком,
   * и кнопка не откроет пустое место.
   */
  onStartEdit?: () => void;
  onDone?: () => void;
}) {
  const { data: videos } = usePropertyVideos(propertyId);
  const downloadVideo = useDownloadVideo(propertyId);
  const deleteVideo = useDeleteVideo(propertyId);
  const [deleteVideoId, setDeleteVideoId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Просмотр сырого видео прямо в браузере (решение владельца 23.08.2026,
  // модерация «посмотреть → одобрить») — presigned-ссылка того же вида, что
  // и у кнопки «Скачать» (downloadVideo), но не открывается в новой вкладке,
  // а проигрывается тут же, чтобы не терять место одобрения материалов.
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [loadingPlayId, setLoadingPlayId] = useState<string | null>(null);
  // Перетаскивание файлов (31.08.2026, просьба владельца «просто бросить
  // видео»): dragCounter вместо простого boolean — dragenter/dragleave
  // срабатывают на КАЖДОМ дочернем элементе при заходе мыши глубже, обычный
  // флаг мигал бы подсветкой на каждой внутренней границе списка видео.
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  async function handlePlay(videoId: string) {
    if (playingId === videoId) {
      setPlayingId(null);
      setPlayUrl(null);
      return;
    }
    setPlayError(null);
    setLoadingPlayId(videoId);
    try {
      const result = await downloadVideo.mutateAsync(videoId);
      setPlayingId(videoId);
      setPlayUrl(result.url);
    } catch (err) {
      setPlayError(err instanceof Error ? err.message : "Не удалось открыть видео");
    } finally {
      setLoadingPlayId(null);
    }
  }

  /**
   * Файлы уходят через очередь (lib/uploadQueue.ts), а не отсюда: ролик в
   * несколько сотен мегабайт идёт минутами, и всё это время загрузку убивало
   * что угодно — лифт, переход на другой экран, заблокированный телефон.
   * Каждый файл — своё задание: повторять пачку гигабайтов из-за одного
   * оборвавшегося ролика нельзя.
   */
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);
    // Размер — ДО очереди (07.10.2026): тяжелее единого предела сервер отвергнет
    // ещё до первого байта; годные уходят, тяжёлые названы по имени.
    const { accepted, rejected } = partitionVideosByLimit(Array.from(files));
    if (rejected.length > 0) {
      setUploadError(rejected.map((f) => videoTooLargeMessage(f.name, formatSize(f.size))).join(" "));
    }
    if (accepted.length === 0) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    try {
      await enqueueVideos(propertyId, accepted, shortId);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Не удалось поставить видео в очередь загрузки");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function handleDragEnter(e: DragEvent) {
    if (readOnly) return;
    e.preventDefault();
    dragCounter.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragActive(true);
  }
  function handleDragOver(e: DragEvent) {
    if (readOnly) return;
    e.preventDefault();
  }
  function handleDragLeave(e: DragEvent) {
    if (readOnly) return;
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  }
  function handleDrop(e: DragEvent) {
    if (readOnly) return;
    e.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    void handleFiles(e.dataTransfer.files);
  }

  async function handleDownload(videoId: string, filename: string) {
    setUploadError(null);
    setDownloadingId(videoId);
    try {
      // Сохранение в Галерею через «Поделиться» — если не получилось (десктоп,
      // браузер не умеет делиться файлами, отказала сеть), не проваливаемся в
      // ошибку, а открываем presigned-ссылку как раньше: скачать всё равно можно.
      const saved = await shareVideoToGallery(propertyId, videoId, filename).catch(() => false);
      if (!saved) {
        const result = await downloadVideo.mutateAsync(videoId);
        window.open(result.url, "_blank", "noopener");
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Не удалось получить ссылку на скачивание");
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDownloadArchive() {
    setArchiveError(null);
    setArchiving(true);
    try {
      await downloadPropertyVideosArchive(propertyId, shortId ?? 0);
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "Не удалось скачать архив");
    } finally {
      setArchiving(false);
    }
  }

  /**
   * РОЛИК УЖЕ УШЁЛ ДАЛЬШЕ ПО КОНВЕЙЕРУ (21.09.2026).
   *
   * Владелец: «человек уже отправил видео, а сырое видео ещё висит, что-то
   * ждёт, хотя видео уже на монтаже». Блок показывался по одному признаку —
   * «мне можно править этот объект», — и про этап передачи не знал ничего.
   * Сырые ролики после передачи с объекта убирают, поэтому пустой список
   * превращался в «Видео пока не загружены. …объект остаётся в подготовке»
   * ровно тогда, когда ждать уже нечего.
   *
   * Пустой блок на этих этапах не рисуем совсем: загружать сюда больше нечего
   * (сервер откажет — routes/properties/videos.ts), а состояние монтажа
   * карточка показывает своими блоками («Решить сейчас», готовый ролик).
   * Если сырые ролики ещё лежат — блок остаётся: монтажёру и маркетингу они
   * нужны, но с честной подписью вместо «ждём».
   */
  const handoffMoved = handoffStatus === "SENT_TO_EDITOR" || handoffStatus === "RECEIVED";
  if (handoffMoved && !videos?.length) return null;

  return (
    /* Карточка эталона: `.sec-h` с действиями справа, ролики строками `.list`/
       `.row`, служебные пояснения и ошибки — тихими строками `.quiet`.
       Перетаскивание сохранено: подсказка о нём тоже тихая строка. */
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="card"
    >
      <div className="sec-h stack">
        <h2>Сырое видео</h2>
        <div className="wrap">
          {!!videos?.length && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={handleDownloadArchive}
              disabled={archiving}
              title="Скачать все видео одним архивом"
            >
              {archiving ? "Архивируем…" : "Скачать всё (.zip)"}
            </button>
          )}
          {readOnly && onStartEdit && (
            <button className="lnk" type="button" onClick={onStartEdit}>
              Изменить исходники
            </button>
          )}
          {!readOnly && (
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => fileInput.current?.click()}
              // Кнопка живая всегда: отправка идёт в очереди, и ждать её, чтобы
              // добавить следующий ролик, незачем.
            >
              Загрузить
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {dragActive && (
        <div className="quiet">
          <span className="dot ok" />
          <span className="txt">Отпустите, чтобы загрузить видео.</span>
        </div>
      )}

      <UploadQueueList propertyId={propertyId} kind="video" />

      {[
        [uploadError, () => setUploadError(null)] as const,
        [archiveError, () => setArchiveError(null)] as const,
        [playError, () => setPlayError(null)] as const,
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

      {handoffMoved && (
        <div className="quiet">
          <span className="dot ok" />
          <span className="txt">
            {handoffStatus === "RECEIVED"
              ? "Монтажёр прислал готовый ролик. Эти файлы — исходники, ждать по ним нечего."
              : "Ролик у монтажёра. Эти файлы — исходники, ждать по ним нечего."}
          </span>
        </div>
      )}

      {!videos?.length ? (
        <div className="empty">
          <span className="ic">
            <svg className="i" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="m10 9 5 3-5 3z" />
            </svg>
          </span>
          <p>Видео пока не загружены.</p>
          {/* Про «остаётся в подготовке» — только когда объект и правда в конвейере
              (этап с сервера), а не по праву править: у объекта в продаже эта фраза
              была неправдой (контракт 06.10.2026, карточка объекта, п. 6). */}
          {inPipeline && (
            <p className="sub">Пока их нет, одобрить видео нельзя, и объект остаётся в подготовке.</p>
          )}
        </div>
      ) : (
        <div className="list">
          {videos.map((v) => (
            <div key={v.id}>
              <div className="row">
                <span className="thumb">
                  <svg className="i" viewBox="0 0 24 24">
                    <rect x="3" y="5" width="18" height="14" rx="3" />
                    <path d="m10 9 5 3-5 3z" />
                  </svg>
                </span>
                <div className="t">
                  <b>{v.filename}</b>
                  <span>
                    {formatSize(v.sizeBytes)} · {v.uploadedByName}
                  </span>
                  {/* Факты сырого файла (23.09.2026, задание C) — пусто, пока фон не
                      разобрал ffprobe'ом после загрузки; чипы тогда просто не рисуем,
                      а не показываем "—" на каждом старом ролике. */}
                  {(v.durationSec != null || (v.width != null && v.height != null) || v.videoCodec || v.hasAudio === false) && (
                    <div className="chips">
                      {v.durationSec != null && <span className="chip mute">{formatDuration(v.durationSec)}</span>}
                      {v.width != null && v.height != null && (
                        <span className="chip mute">
                          {v.width}×{v.height}
                        </span>
                      )}
                      {v.videoCodec && <span className="chip mute">{v.videoCodec}</span>}
                      {v.hasAudio === false && <span className="chip crit">⚠ без звука</span>}
                    </div>
                  )}
                </div>
                <div className="act">
                  <button
                    className="lnk"
                    type="button"
                    onClick={() => handlePlay(v.id)}
                    disabled={loadingPlayId === v.id}
                  >
                    {loadingPlayId === v.id ? "Открываем…" : playingId === v.id ? "Свернуть" : "Смотреть"}
                  </button>
                  <button
                    className="lnk"
                    type="button"
                    onClick={() => handleDownload(v.id, v.filename)}
                    disabled={downloadingId === v.id}
                  >
                    {downloadingId === v.id ? "Готовим…" : "Скачать"}
                  </button>
                  {!readOnly && (
                    <button className="lnk" type="button" onClick={() => setDeleteVideoId(v.id)}>
                      Удалить
                    </button>
                  )}
                </div>
              </div>
              {playingId === v.id && playUrl && (
                <VideoPlayerWithFallback src={playUrl} autoPlay onDownload={() => handleDownload(v.id, v.filename)} />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Видео удаляется из хранилища автоматически после того, как монтажёр вставит ссылку на готовый ролик и
          нажмёт «Готово».
        </span>
      </div>

      {!readOnly && onDone && (
        <div className="quiet">
          <span className="spacer" />
          <button className="pill sm" type="button" onClick={onDone}>
            Готово
          </button>
        </div>
      )}

      {deleteVideoId && (
        <ConfirmDialog
          title="Удалить видео?"
          description="Файл удалится из хранилища без возможности восстановить."
          confirmLabel="Удалить"
          danger
          onConfirm={() => {
            deleteVideo.mutate(deleteVideoId);
            setDeleteVideoId(null);
          }}
          onCancel={() => setDeleteVideoId(null)}
        />
      )}
    </div>
  );
}

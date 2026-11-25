import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Clock, FileText, ImageOff, Lock, Mic, X } from "lucide-react";
import { whereToLook } from "@royal-home/shared";
import { browserPlays, useAttachmentUrl, usePlayableUrl } from "../lib/attachmentUrl";
import type { MessageAttachment } from "../types";
import { RhAudioPlayer } from "./look/RhAudioPlayer";

/**
 * Фото и голосовые, присланные клиентом в переписку.
 *
 * Показываются и в инбоксе, и в карточке клиента — поэтому вынесено в общий
 * компонент, а не продублировано на двух экранах.
 *
 * Главная особенность: файл нельзя вставить в `<img src>` напрямую. Он лежит в
 * закрытом хранилище и отдаётся маршрутом с проверкой права по заголовку
 * Authorization, а тег `<img>` никаких заголовков не шлёт — получилась бы битая
 * картинка. Поэтому качаем файл сами и показываем через blob-ссылку (само
 * скачивание — lib/attachmentUrl.ts, общее с ChatPhotoViewer).
 */

/** Во весь экран по нажатию на миниатюру — на телефоне иначе ничего не разглядеть. */
function Fullscreen({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 bg-black/90 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <button type="button"
        onClick={onClose}
        aria-label="Закрыть"
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 text-white flex items-center justify-center hover:bg-white/20"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={url}
        alt="Вложение из переписки"
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}

/** Пометка вместо вложения: у сотрудника нет права или файл не отдался. Показываем
 *  словами, а не пустотой и не сломанной картинкой — иначе выглядит как ошибка CRM.
 *
 *  В облике темы 2026 это строка `.att` прототипа без кнопки (screens/messages.html) —
 *  та же строка со значком, что и у настоящего вложения: пометка обязана стоять
 *  на его месте, а не выглядеть чужеродной плашкой. */
function Note({ icon: Icon, children, rh2 }: { icon: typeof Lock; children: React.ReactNode; rh2: boolean }) {
  if (rh2) {
    return (
      <span className="att" style={{ cursor: "default" }}>
        <Icon className="i" strokeWidth={1.8} />
        {children}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 bg-line-soft border border-line rounded-lg px-2 py-1">
      <Icon className="w-3 h-3 shrink-0" strokeWidth={1.8} />
      {children}
    </span>
  );
}

/** Подпись, когда права на вложения нет: имя файла сюда даже не приезжает. */
const KIND_LOCKED: Record<string, string> = {
  image: "Фото: доступно руководству",
  audio: "Голосовое: доступно руководству",
  video: "Видео: доступно руководству",
  file: "Документ: доступно руководству",
};

/** Что не сохранилось и почему — простыми словами (lib/customerInputMedia.ts на сервере). */
const LOST_WHAT: Record<string, string> = { image: "фото", audio: "голосовое", video: "видео", file: "файл" };
const LOST_WHY: Record<string, string> = {
  unsupported: "формат CRM не открывает",
  failed: "не скачалось",
  too_many: "слишком много файлов за раз",
};
const LOST_LIMIT: Record<string, string> = {
  image: "больше 5 МБ",
  audio: "длиннее 10 минут или больше 3 МБ",
  video: "больше 16 МБ или длиннее 3 минут",
  file: "больше 16 МБ",
};

export function lostAttachmentText(kind: string, reason: string, channel?: string | null): string {
  const what = LOST_WHAT[kind] ?? "файл";
  const why = reason === "too_big" || reason === "too_long" ? LOST_LIMIT[kind] ?? "слишком большой" : LOST_WHY[reason] ?? LOST_WHY.failed;
  return `Клиент прислал ${what} — ${why}, в CRM не сохранилось. Откройте ${whereToLook(channel)}`;
}

function AttachmentItem({
  attachment,
  rh2,
  bubble,
  onImageClick,
  channel,
}: {
  attachment: MessageAttachment;
  rh2: boolean;
  /** Внутри пузыря переписки (инбокс и мобильный диалог) — голосовое рисуется без подложки. */
  bubble: boolean;
  /** Открыть кадр в просмотрщике ВСЕЙ переписки, а не в одиночном Fullscreen
   *  ниже — задаётся только там, где просмотрщик есть (Messages.tsx). Без него —
   *  прежнее поведение «во весь экран». */
  onImageClick?: () => void;
  channel?: string | null;
}) {
  /**
   * ПРЯМАЯ ССЫЛКА (25.11.2026, «фото и видео не открываются»). Сервер кладёт в
   * вложение подписанную ссылку `src` (lib/chatAttachmentLinks.ts на сервере), и
   * тег грузит файл сам: лениво, кусками (Range — перемотка видео и голосовых),
   * из кэша браузера. Раньше КАЖДЫЙ файл диалога качался целиком в момент
   * открытия, и четыре видео по 16 МБ держали серую заглушку минутами.
   * Прямая ссылка не сработала (устарела, сеть) — один раз прежним путём:
   * скачать с заголовком Authorization.
   */
  /**
   * УСТОЙЧИВЫЕ ССЫЛКИ (ревью #428). Переписка опрашивается, и раз в два часа сервер
   * выдаёт ту же ссылку с новой подписью. Менять `src` у идущего видео нельзя — оно
   * начнётся сначала. Поэтому держим первую выданную ссылку на ЭТОТ файл и берём
   * новую только когда старая не открылась (подпись истекла). Новый файл (другое
   * вложение на том же месте) — всё с начала: и ссылки, и состояние видео.
   */
  const fileKey = attachment.file ?? attachment.url ?? "";
  const [links, setLinks] = useState({ key: fileKey, src: attachment.src, thumb: attachment.thumb, play: attachment.play, broken: false });
  const [videoStep, setVideoStep] = useState<"original" | "play" | "broken">("original");
  if (links.key !== fileKey) {
    setLinks({ key: fileKey, src: attachment.src, thumb: attachment.thumb, play: attachment.play, broken: false });
    setVideoStep("original");
  }
  /**
   * Пришла свежая подпись той же ссылки (переписка опрашивается). Пока замороженная
   * ссылка работает, её не трогаем; не открылась — сначала берём свежую, и только
   * если свежей нет, считаем прямую ссылку сломанной (повторное ревью #428: истёкшая
   * подпись у видео/голосового уводила в «не воспроизводится» с просроченной ссылкой).
   */
  const hasFresherLinks = !!attachment.src && attachment.src !== links.src;
  const refreshLinks = () =>
    setLinks({ key: fileKey, src: attachment.src, thumb: attachment.thumb, play: attachment.play, broken: false });
  /** Прямая ссылка не открылась: есть свежая подпись — берём её, иначе прежний путь. */
  const onDirectError = () => {
    if (hasFresherLinks) refreshLinks();
    else setLinks((l) => ({ ...l, broken: true }));
  };
  const direct = !attachment.url && !!links.src;
  const useDirect = direct && !links.broken;
  // Фотография объекта, которую отправил бот, лежит в открытой папке /uploads и
  // подставляется в <img> напрямую — качать её через маршрут с правом не нужно.
  const stored = useAttachmentUrl(attachment.url || useDirect || attachment.lost ? null : attachment.file);
  const isImage = attachment.kind === "image";
  const fullUrl = attachment.url ?? (useDirect ? links.src ?? null : stored.url);
  const url = attachment.url ?? (useDirect ? (isImage ? links.thumb ?? links.src ?? null : links.src ?? null) : stored.url);
  const failed = attachment.url || useDirect ? false : stored.failed;
  const [zoomed, setZoomed] = useState(false);
  // Голосовое ogg/opus, которое этот браузер не играет, — сразу версия m4a.
  const audioNeedsPlay = attachment.kind === "audio" && useDirect && !!links.play && !browserPlays(attachment.mime);
  // Версия для браузера готовится на сервере (503 + Retry-After) — ждём её, а не
  // подсовываем плееру адрес, который пока отвечает ошибкой.
  const playable = usePlayableUrl(links.play ?? null, (attachment.kind === "video" && videoStep === "play") || audioNeedsPlay);
  // Версия для браузера ответила 403 — подпись истекла: берём свежую, как только она есть.
  useEffect(() => {
    if (playable.state === "expired" && hasFresherLinks) refreshLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- реагируем на смену состояния и свежую ссылку
  }, [playable.state, attachment.src]);

  // Клиент прислал, а сохранить не вышло — честная причина, а не пустота.
  if (attachment.lost) {
    return <Note icon={AlertTriangle} rh2={rh2}>{lostAttachmentText(attachment.kind, attachment.lost, channel)}</Note>;
  }

  // Файл убран уборкой по сроку хранения (lib/outgoingMediaCleanup.ts, 7 дней) —
  // честная пометка вместо битой картинки/404. Проверяем ДО попытки скачать: сам
  // адрес всё ещё существует в переписке, но за ним в R2 уже пусто.
  if (attachment.expiredAt) {
    return <Note icon={Clock} rh2={rh2}>Файл удалён по сроку хранения (7 дней)</Note>;
  }

  // Права нет — честная надпись. Имя файла сюда даже не приезжает (сервер его снимает),
  // так что показать нечего и обходить нечего.
  if (!attachment.file && !attachment.url) {
    return (
      <Note icon={Lock} rh2={rh2}>{KIND_LOCKED[attachment.kind] ?? "Вложение: доступно руководству"}</Note>
    );
  }

  if (failed) {
    return <Note icon={ImageOff} rh2={rh2}>Вложение не открылось</Note>;
  }

  if (!url || !fullUrl) {
    if (rh2) {
      // `.sk` прототипа: тот же скелетон, что у остальных состояний макета.
      return (
        <span
          className="sk"
          style={{ display: "block", width: 180, height: isImage ? 120 : 32, marginTop: 6 }}
          aria-label="Загрузка вложения"
        />
      );
    }
    return (
      <span
        className={`inline-block rounded-lg bg-line-soft animate-pulse ${isImage ? "w-[88px] h-[88px]" : "w-[180px] h-8"}`}
        aria-label="Загрузка вложения"
      />
    );
  }

  if (isImage) {
    return (
      <>
        <button
          type="button"
          onClick={() => (onImageClick ? onImageClick() : setZoomed(true))}
          className={
            rh2
              ? "att-img"
              : "block rounded-lg overflow-hidden border border-line hover:opacity-90 focus:outline-hidden focus:ring-2 focus:ring-blue/40"
          }
          title="Открыть во весь экран"
        >
          <img
            src={url}
            alt={attachment.url ? "Фото объекта, отправленное клиенту" : "Фото от клиента"}
            className={rh2 ? undefined : "w-[88px] h-[88px] object-cover"}
            style={rh2 ? { width: "100%", height: "100%", objectFit: "cover", display: "block" } : undefined}
            loading="lazy"
            decoding="async"
            onError={() => {
              if (useDirect) onDirectError();
            }}
          />
        </button>
        {zoomed && <Fullscreen url={fullUrl} onClose={() => setZoomed(false)} />}
      </>
    );
  }

  /**
   * ВИДЕО (16.08.2026). До этого дня любое не-изображение рисовалось плеером
   * ЗВУКА: присланный рум-тур давал пустую полоску, которую нельзя ни включить,
   * ни посмотреть. Видео квартиры — самое ценное, что присылает продавец, и
   * смотреть его должен агент, а не только модель.
   *
   * preload="none": в переписке таких вложений бывает десяток, и качать их все
   * при открытии диалога значило бы отдать мобильный трафик агента впустую.
   */
  if (attachment.kind === "video") {
    if (videoStep === "broken") {
      return (
        <Note icon={ImageOff} rh2={rh2}>
          Видео не воспроизводится в браузере.{" "}
          <a href={fullUrl} download style={{ textDecoration: "underline" }}>
            Скачать
          </a>
        </Note>
      );
    }
    if (videoStep === "play" && playable.state !== "ready") {
      if (playable.state === "expired") {
        return <Note icon={Clock} rh2={rh2}>Обновляем ссылку на видео…</Note>;
      }
      if (playable.state === "failed") {
        return (
          <Note icon={ImageOff} rh2={rh2}>
            Видео не воспроизводится в браузере.{" "}
            <a href={fullUrl} download style={{ textDecoration: "underline" }}>
              Скачать
            </a>
          </Note>
        );
      }
      return <Note icon={Clock} rh2={rh2}>Готовим видео для браузера…</Note>;
    }
    const videoSrc = videoStep === "play" && links.play ? links.play : url;
    return (
      <video
        // Ключ — файл и шаг, а не адрес: новая подпись той же ссылки не перезапускает ролик.
        key={`${fileKey}:${videoStep}`}
        src={videoSrc}
        controls
        // metadata, а не none: по прямой ссылке браузер берёт только заголовок
        // файла (несколько КБ кусками Range) — видна длина и первый кадр, а не
        // чёрный прямоугольник. Сам ролик качается только по «играть».
        preload={useDirect ? "metadata" : "none"}
        playsInline
        onError={() => {
          // Сначала — не истекла ли подпись: свежая ссылка, шаг тот же.
          if (useDirect && hasFresherLinks) refreshLinks();
          else if (videoStep === "original" && useDirect && links.play) setVideoStep("play");
          else if (useDirect) setVideoStep("broken");
        }}
        className={rh2 ? undefined : "rounded-lg border border-line max-w-[240px] w-full"}
        style={
          rh2
            ? {
                marginTop: 6,
                width: 240,
                maxWidth: "100%",
                borderRadius: "var(--r-sm)",
                border: "1px solid var(--line-soft)",
                display: "block",
              }
            : undefined
        }
      />
    );
  }

  /** Документ: смотреть нечего, но скачать и открыть человек должен. */
  if (attachment.kind === "file") {
    return (
      <a
        href={url}
        {...(useDirect ? { target: "_blank", rel: "noopener noreferrer" } : { download: true })}
        className={
          rh2
            ? "att"
            : "inline-flex items-center gap-1.5 text-[13px] text-blue bg-blue/[.07] border border-blue/20 rounded-lg px-2 py-1 hover:bg-blue/12"
        }
      >
        <FileText className={rh2 ? "i" : "w-3.5 h-3.5 shrink-0"} strokeWidth={1.8} />
        Открыть документ
      </a>
    );
  }

  // Голосовое WhatsApp/Telegram — ogg/opus; Safari старше iOS 18.4 его не играет.
  // Браузер честно говорит это заранее (canPlayType) — тогда сразу версия m4a,
  // иначе оригинал, а m4a — запасной путь на ошибку плеера.
  if (audioNeedsPlay && playable.state !== "ready") {
    return playable.state === "expired" ? (
      <Note icon={Clock} rh2={rh2}>Обновляем ссылку на голосовое…</Note>
    ) : playable.state === "failed" ? (
      <Note icon={ImageOff} rh2={rh2}>
        Голосовое не воспроизводится в этом браузере.{" "}
        <a href={fullUrl} download style={{ textDecoration: "underline" }}>
          Скачать
        </a>
      </Note>
    ) : (
      <Note icon={Clock} rh2={rh2}>Готовим голосовое…</Note>
    );
  }
  const audioSrc = audioNeedsPlay && links.play ? links.play : url;
  const audioFallback = useDirect && links.play && audioSrc !== links.play ? links.play : undefined;
  return (
    /**
     * ГОЛОСОВОЕ ДОЛЖНО БЫТЬ ЯВНО СЛЫШНО, А НЕ ТОЛЬКО ПРОЧИТАНО (16.08.2026, по
     * замечанию владельца: расшифровка бывает выдумана — модель иногда сочиняет
     * правдоподобный текст на тихой записи вместо честного признания, что не
     * расслышала (см. audioTranscode.ts → isSilentAudio). Раз текст не гарантия,
     * плеер — не украшение рядом с ним, а единственный надёжный источник.
     *
     * Раньше ширина плеера была `w-full` внутри `inline-flex` БЕЗ явной ширины
     * родителя — циклическая зависимость (родитель считает ширину по контенту,
     * контент просит 100% родителя), и в разных браузерах плеер мог схлопнуться
     * почти до нуля: агент видел только значок микрофона без самого плеера.
     * Фиксированная ширина этого не допускает.
     */
    rh2 ? (
      <div className="voice">
        <Mic className="i" strokeWidth={1.8} />
        <RhAudioPlayer src={audioSrc} fallbackSrc={audioFallback} onLoadError={useDirect && hasFresherLinks ? () => { refreshLinks(); return true; } : undefined} speeds preload={useDirect ? "metadata" : "none"} label="Голосовое" className="w-[300px] max-w-full" />
      </div>
    ) : bubble ? (
      // Как в WhatsApp: плеер прямо в пузыре, без белой подложки и значка микрофона. Файл уже скачан
      // (blob), поэтому длина читается из него сразу — вместо «0:00» до первого нажатия.
      <div className="mt-1" data-voice-in-bubble="">
        <RhAudioPlayer src={audioSrc} fallbackSrc={audioFallback} onLoadError={useDirect && hasFresherLinks ? () => { refreshLinks(); return true; } : undefined} speeds preload="metadata" label="Голосовое" inBubble className="w-[280px] max-w-full" />
      </div>
    ) : (
      <div className="mt-1 flex items-center gap-1.5 rounded-lg border border-line bg-card px-2 py-1.5">
        <Mic className="h-3.5 w-3.5 shrink-0 text-gray-400" strokeWidth={1.8} />
        <RhAudioPlayer src={audioSrc} fallbackSrc={audioFallback} onLoadError={useDirect && hasFresherLinks ? () => { refreshLinks(); return true; } : undefined} speeds preload={useDirect ? "metadata" : "none"} label="Голосовое" className="w-[300px] max-w-full" />
      </div>
    )
  );
}

/**
 * ОБЛИК. `rh2` включает вложения прототипа: строка `.att` (документ, голосовое,
 * пометка о праве) и плитка `.att-img` 180x120 для фото — дословно из
 * screens/messages.html. Проп НЕОБЯЗАТЕЛЕН, потому что этот же компонент
 * рендерят инбокс (Messages.tsx), мобильный диалог (MobileChatView.tsx) и
 * карточка вакансии (VacancyDetails.tsx) — три экрана, которые пока живут вне
 * `.rh2`: безусловный перевод оставил бы вложения там без стилей вовсе.
 */
export function MessageAttachments({
  attachments,
  rh2 = false,
  inBubble = false,
  onImageClick,
  channel,
}: {
  attachments?: MessageAttachment[];
  /** Канал переписки — для пометки «откройте в WhatsApp» у несохранённого файла. */
  channel?: string | null;
  rh2?: boolean;
  /** Вложения лежат в пузыре переписки (`.bub`): голосовое без белой карточки. */
  inBubble?: boolean;
  /**
   * Открыть просмотрщик ВСЕЙ переписки (21.09.2026, «фото листаются свайпом по
   * всем фото переписки»), а не Fullscreen одного кадра. Аргумент — индекс
   * кадра СРЕДИ ФОТО ЭТОГО СООБЩЕНИЯ (0, 1, 2…), не среди всех вложений: голосовые
   * и документы в счёт не идут. Вызывающий (Messages.tsx/MobileChatView.tsx)
   * прибавляет к нему смещение по предыдущим сообщениям — здесь этого смещения
   * никто не знает, компонент вложений не хранит историю диалога целиком.
   */
  onImageClick?: (imageIndexInMessage: number) => void;
}) {
  // Старые реплики поля не имеют вовсе — тогда компонент не рисует ничего и
  // переписка выглядит ровно как раньше.
  if (!attachments || attachments.length === 0) return null;
  let imageIndex = -1;
  return (
    <div
      className={rh2 ? undefined : "flex flex-wrap items-center gap-1.5 mt-1.5"}
      style={rh2 ? { display: "flex", flexDirection: "column", alignItems: "flex-start" } : undefined}
    >
      {attachments.map((attachment, i) => {
        const isImage = attachment.kind === "image";
        if (isImage) imageIndex += 1;
        const capturedIndex = imageIndex;
        return (
          <AttachmentItem
            key={i}
            attachment={attachment}
            rh2={rh2}
            bubble={inBubble}
            onImageClick={isImage && onImageClick ? () => onImageClick(capturedIndex) : undefined}
            channel={channel}
          />
        );
      })}
    </div>
  );
}

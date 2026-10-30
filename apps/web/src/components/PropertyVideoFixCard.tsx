import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import {
  VIDEO_REMAKE_REASONS,
  VIDEO_REMAKE_REASON_LABELS,
  VIDEO_REMAKE_REASONS_REQUIRING_COMMENT,
  publishedPostLink,
  hasManualVideoLink,
  montajerMayUploadFinal,
  type VideoRemakeReason,
} from "@royal-home/shared";
import type { Property } from "../types";
import { api } from "../lib/api";
import { httpStatusMessage } from "../lib/httpStatusMessage";
import { uploadVideoChunked, uploadVideoNow, retryDelayMs, MAX_RETRY_ATTEMPTS } from "../lib/uploadQueue";
import { dushanbeDateTime, dushanbeTime } from "../lib/date";
import { isPublishPlanned } from "../lib/publishPlanned";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import { VideoPlayerWithFallback } from "./VideoPlayerWithFallback";
import { useRovingRadio } from "../hooks/useRovingRadio";
import {
  useVideoHandoffQueueState,
  useResendVideoHandoff,
  useHoldVideoHandoff,
  useUnholdVideoHandoff,
  useMoveVideoHandoff,
  useChannelsStatus,
} from "../hooks/useMarketing";
import { CancelHolderDialog, useHandoffMutationBusy, errorText } from "./handoff/CancelHolderDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChannelIcon } from "./ChannelIcon";
import { effectivePublishedChannels } from "../lib/effectivePublishedChannels";

/**
 * «ЧТО-ТО НЕ ТАК С ВЫПУЩЕННЫМ РОЛИКОМ» — одна панель на все четыре способа
 * исправления (владелец 19.09.2026, после перемешанных описаний двух квартир:
 * «чтобы не проходить весь путь заново и не заполнять карточку второй раз»).
 *
 * Сервер — lib/publishedVideoFix.ts, маршруты в routes/properties/videos.ts.
 *
 * ПОЧЕМУ ОДНОЙ ПАНЕЛЬЮ, А НЕ ЧЕТЫРЬМЯ КНОПКАМИ ПО КАРТОЧКЕ. Человек приходит
 * сюда с одной мыслью — «ролик неправильный» — и не знает заранее, чинить ли
 * монтаж, текст или снимать пост. Четыре кнопки в разных местах заставляли бы
 * его выбирать инструмент до того, как он понял задачу. Здесь они идут одним
 * списком, сверху вниз в порядке «чаще всего нужно».
 *
 * ПОКАЗЫВАЕТСЯ ТОЛЬКО ТОГДА, КОГДА ЕСТЬ ЧТО ЧИНИТЬ: объект уже где-то
 * опубликован или у него есть готовый ролик. До этого момента обычный путь
 * (модерация материалов → монтаж) ещё не пройден, и панель была бы шумом.
 *
 * Идиома — «Royal Home 2026»: `.card` + `.sec-h`, строка решения `.mod.solve`,
 * итоги тихой строкой `.quiet` с точкой `.dot`. Красных кнопок нет (§6.10):
 * снятие постов красное только точкой и текстом, а сам вопрос задаётся
 * шторкой ConfirmDialog — оно необратимо.
 */

type ManualStep = { channel: "INSTAGRAM" | "TIKTOK" | "THREADS"; url: string | null; reason: string };
type RemovalResult = {
  removed: string[];
  failed: { channel: string; error: string }[];
  manual: ManualStep[];
  /** Снятие не начиналось (идёт публикация) — сервер, lib/publishedVideoFix.ts. */
  blocked?: string;
};
type CaptionResult = { caption: string; updated: string[]; failed: { channel: string; error: string }[]; manual: ManualStep[] };

/** Одна запись из истории «что ушло монтажёру» — GET .../montajer-messages
 *  (первая отправка на монтаж, перемонтаж с причиной, снятие с монтажа,
 *  квитанция после приёма ролика; свежие сверху, сервер сам режет выборку). */
type MontajerMessageKind = "HANDOFF" | "REMAKE" | "CANCELLED" | "PROPERTY_DELETED" | "RECEIPT" | "FACTS_CHANGED";
type MontajerMessage = { id: string; kind: MontajerMessageKind; text: string; sentAt: string };

/** Тот же предел, что режет выборку на сервере (routes/properties/videos.ts,
 *  `MONTAJER_MESSAGES_LIMIT = 100`) — сюда не экспортирован, значение зеркалим
 *  вручную только чтобы понять, могли ли остаться более старые записи. */
const MONTAJER_MESSAGES_LIMIT = 100;

/** Вид сообщения — человеческим словом рядом с датой: список читают глазами,
 *  ища «когда же уехал перемонтаж», а не перечитывая текст каждой записи.
 *  Неизвестный вид (сервер завёл новый, фронт ещё не знает) не ломает строку и
 *  не печатает сырой код — просто остаётся без ярлыка. */
const MONTAJER_MESSAGE_KIND: Record<MontajerMessageKind, string> = {
  HANDOFF: "Передан на монтаж",
  REMAKE: "Перемонтаж",
  CANCELLED: "Снят с монтажа",
  PROPERTY_DELETED: "Объект удалён",
  RECEIPT: "Ответ после приёма",
  FACTS_CHANGED: "Карточка изменена",
};

/**
 * Причины возврата монтажёру (решение владельца 20.09.2026): «чтобы просто
 * так не ходил, а причину чтобы я указал, зачем, чтобы он тоже прочитал» —
 * раньше кнопка отправляла запрос без единого слова.
 *
 * Контракт с сервером: `POST .../send-back-to-montajer { reason, comment? }`.
 * `comment` обязателен у WRONG_CAPTION и OTHER, сервер это тоже проверит —
 * здесь блокируем кнопку раньше, чтобы не ходить впустую и не получать 400
 * после нажатия (§ требование «блокируй кнопку, а не ругайся после»).
 *
 * Коды, подписи причин и то, какой причине обязателен комментарий, — из
 * `@royal-home/shared` (`videoRemake.ts`), один источник правды с сервером
 * (24.09.2026: раньше список дублировался здесь же руками и однажды разошёлся
 * бы). Локально остаются только подсказка в поле и мелкая пометка под подписью.
 */
const SEND_BACK_REASON_EXTRA: Partial<Record<VideoRemakeReason, { hint?: string; note?: string }>> = {
  WRONG_CAPTION: { hint: "Что именно неверно? Например: район указан Сино, а должен быть Шохмансур" },
  CARD_DATA_CHANGED: { note: "Это не ошибка монтажёра" },
};

const SEND_BACK_REASONS: {
  value: VideoRemakeReason;
  label: string;
  commentRequired: boolean;
  /** Подсказка внутри поля комментария — только там, где владелец её задал. */
  hint?: string;
  /** Мелкая пометка под подписью — сейчас только у CARD_DATA_CHANGED. */
  note?: string;
}[] = VIDEO_REMAKE_REASONS.map((value) => ({
  value,
  label: VIDEO_REMAKE_REASON_LABELS[value],
  commentRequired: VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(value),
  hint: SEND_BACK_REASON_EXTRA[value]?.hint,
  note: SEND_BACK_REASON_EXTRA[value]?.note,
}));

/** Значения второй radiogroup диалога («Исходник для монтажа») — вынесены на
 *  уровень модуля ради стабильной ссылки для useRovingRadio. */
const SOURCE_MODES = ["keep", "new"] as const;

const CHANNEL_NAMES: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TELEGRAM: "Telegram-канал",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  THREADS: "Threads",
};

function channelList(channels: string[]): string {
  return channels.map((c) => CHANNEL_NAMES[c] ?? c).join(", ");
}

/** Итог снятия постов одной строкой — один текст для «Убрать из соцсетей»,
 *  возврата монтажёру со снятием и загрузки замены со снятием (25.09.2026). */
function removalParts(r: RemovalResult): string[] {
  const parts: string[] = [];
  if (r.blocked) parts.push(`старый ролик не убран: ${r.blocked}`);
  if (r.removed.length > 0) parts.push(`убрано: ${channelList(r.removed)}`);
  if (r.failed.length > 0) {
    parts.push(`не получилось: ${r.failed.map((f) => `${CHANNEL_NAMES[f.channel] ?? f.channel} — ${f.error}`).join("; ")}`);
  }
  return parts;
}

/**
 * «ВИДНО, ГДЕ РОЛИК ЕСТЬ, А ГДЕ НЕТ» (ОБ-000113, владелец 21.09.2026, дословно:
 * «сделай так, чтобы такие ошибки я видел, что куда не попало; везде ли есть
 * ролик — можно просто иконки соцсетей и галочки, где они есть»).
 *
 * Живой случай: ролик ушёл в YouTube/Facebook/TikTok/Telegram, а в Instagram —
 * нет, и объект простоял всю ночь без единой видимой причины — журнал ошибок был
 * пуст (не звал logSystemError, см. lib/socialPublish.ts), карточка молчала
 * «На монтаже». Пять сетей — не статистика просмотров (её владелец попросил
 * отдельно, потом), а факт «дошло / не дошло / пытались и не вышло».
 *
 * Порядок — тот, что назвал владелец: Instagram, Facebook, YouTube, TikTok,
 * Telegram. THREADS добавлен в конец (23.09.2026, шестой канал) — владелец
 * порядок для него не называл, ставим последним, ничего не переставляя.
 */
const PUBLISH_CHANNEL_ORDER = ["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS"] as const;

/* Публичная ссылка на пост — publishedPostLink из @royal-home/shared (25.09.2026):
 * то же правило нужно боту монтажёра («📈 Где вышел»), копии разошлись бы.
 * Threads (23.09.2026) добавлен туда же, а не здесь локально — см.
 * packages/shared/src/publishedPostLink.ts, ключ publishedPostIds.THREADS_URL. */

/**
 * ПРЕДПРОСМОТР КАРТОЧКИ-ИСТОРИИ (21.09.2026). Сервер умел рисовать её с самого
 * начала (`GET /properties/:id/story-card.jpg`), но ни один экран её не
 * показывал — печать «Продано» и подписи приходилось проверять уже после
 * публикации, глазами в Instagram. Грузится по нажатию, а не сразу: это
 * полноразмерный JPEG 1080x1920 на каждый открытый объект.
 *
 * Картинка идёт через `api(responseType:"blob")`, а не через <img src>: роут
 * закрыт `requireAuth`, а тег <img> заголовок с токеном не отправляет (тот же
 * приём, что в MessageAttachments.tsx).
 */
function StoryCardPreview({ propertyId }: { propertyId: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(null);
    api<Blob>(`/properties/${propertyId}/story-card.jpg`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : "Не удалось нарисовать карточку");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, propertyId]);

  if (!open) {
    return (
      <button className="lnk" type="button" onClick={() => setOpen(true)}>
        Посмотреть карточку
      </button>
    );
  }
  if (failed) {
    return (
      <p className="quiet crit" role="alert">
        <span className="dot crit" />
        <span className="txt">{failed}</span>
      </p>
    );
  }
  if (!url) {
    return (
      <p className="quiet">
        <span className="dot" />
        <span className="txt">Рисуем…</span>
      </p>
    );
  }
  return <img src={url} alt="Карточка объекта для истории" style={{ maxWidth: 220, width: "100%", borderRadius: 10 }} />;
}

interface SourceVideo {
  id: string;
  filename: string;
  sizeBytes: number;
  /** Задание C (23.09.2026) — предупредить агента, что оставляет без звука,
   *  ДО того, как объект снова уйдёт монтажёру. null — факт ещё не разобран. */
  hasAudio: boolean | null;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/** «1:20» — минуты:секунды, тем же приёмом, что у formatDuration в
 *  PropertyVideoManager.tsx (не общий модуль — три строки форматирования не
 *  стоят импорта между несвязанными компонентами). */
function formatVideoDuration(sec: number): string {
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** «В очереди, 3-й (отложен: причина)» / «У монтажёра Сади с 12:40 (5 ч)» /
 *  «Ролик получен 14:02, выйдет 15:30» / «Снят с монтажа» — одна строка
 *  состояния (25.09.2026, задание C: «чтобы в карточке объекта всё было»). */
function montageStatusLine(vh: NonNullable<Property["videoHandoff"]>): string {
  if (vh.status === "QUEUED") {
    const posText = vh.queuePosition != null ? `, ${vh.queuePosition - 1}-й` : "";
    const heldText = vh.heldAt ? ` (отложен${vh.holdReason ? `: ${vh.holdReason}` : ""})` : "";
    return `В очереди${posText}${heldText}`;
  }
  if (vh.status === "SENT_TO_EDITOR") {
    const name = vh.montajer?.fullName ?? "монтажёра";
    const since = vh.sentAt ? dushanbeDateTime(vh.sentAt) : null;
    const hours = vh.sentAt ? Math.floor((Date.now() - new Date(vh.sentAt).getTime()) / 3_600_000) : null;
    return `У монтажёра ${name}${since ? ` с ${since}` : ""}${hours != null ? ` (${hours} ч)` : ""}`;
  }
  // RECEIVED. Снятие с монтажа тоже переводит объект в RECEIVED (closeVideoHandoff,
  // lib/videoHandoff.ts) — без реального файла (`receivedAt` пуст), поэтому «ролик
  // получен» здесь было бы неправдой.
  if (!vh.receivedAt) return "Снят с монтажа";
  const receivedText = dushanbeDateTime(vh.receivedAt);
  if (vh.scheduledPublishAt && new Date(vh.scheduledPublishAt).getTime() > Date.now()) {
    return `Ролик получен ${receivedText}, выйдет ${dushanbeTime(vh.scheduledPublishAt)}`;
  }
  return `Ролик получен ${receivedText}`;
}

/**
 * БЛОК «МОНТАЖ» (25.09.2026, владелец: «чтобы была возможность придерживать
 * какой-то монтаж на паузе, повторно отправить монтажёру, чтобы в карточке
 * объекта всё было, и в списке объектов сразу видеть, в каком состоянии»).
 *
 * Видим ВСЕМ, кто видит компонент (не только canEdit) — состояние монтажа не
 * действие, а факт про объект; кнопки внутри уже сами проверяют canEdit по
 * одному месту (routes/marketing.ts::requireEditorsLoadRole — та же роль, что
 * открывает /marketing/queue, здесь заменена на canEdit, ближайшее к ней
 * право на самой карточке).
 */
function MontageBlock({
  property,
  canEdit,
  viewer = "staff",
  onSendBack,
}: {
  property: Property;
  canEdit: boolean;
  /** Режим монтажёра (25.09.2026, панель монтажёра) — те же кнопки очереди,
   *  что уже даёт ему `EditorPipeline` (решение владельца 19.09.2026, сервер
   *  их и так пускает EDITOR), подпись кнопки повтора и плеер своего ролика. */
  viewer?: "staff" | "montajer";
  /** Открывает существующий диалог «Вернуть монтажёру» (openSendBack в
   *  PropertyVideoFixCard) — кнопка возврата в блоке проверки клипа не заводит
   *  свой диалог, а зовёт тот же самый. */
  onSendBack: () => void;
}) {
  const isMontajerViewer = viewer === "montajer";
  const canQueueControl = isMontajerViewer ? true : canEdit;
  const vh = property.videoHandoff;
  const { data: queueState } = useVideoHandoffQueueState(vh?.status === "QUEUED" || vh?.status === "SENT_TO_EDITOR");
  const resend = useResendVideoHandoff();
  const hold = useHoldVideoHandoff();
  const unhold = useUnholdVideoHandoff();
  const move = useMoveVideoHandoff();
  const busy = useHandoffMutationBusy();
  const [cancelling, setCancelling] = useState(false);
  const [holding, setHolding] = useState(false);
  const [holdReason, setHoldReason] = useState("");

  const can = useCan();
  const canModerateClip = can("properties.moderate");
  const qc = useQueryClient();
  const [clipBusy, setClipBusy] = useState(false);
  const [clipMessage, setClipMessage] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);

  async function approveClip() {
    if (!vh) return;
    setClipError(null);
    setClipMessage(null);
    setClipBusy(true);
    try {
      const r = await api<{ ok: boolean; scheduledPublishAt: string | null; notPublishingReason: string | null }>(
        `/properties/${property.id}/clip-review/approve`,
        { method: "POST" }
      );
      setClipMessage(
        r.notPublishingReason
          ? `Одобрено. ${r.notPublishingReason}`
          : r.scheduledPublishAt
            ? `Одобрено — выйдет ${dushanbeTime(r.scheduledPublishAt)}`
            : "Одобрено."
      );
      await qc.invalidateQueries({ queryKey: ["property"] });
      await qc.invalidateQueries({ queryKey: ["properties"] });
    } catch (err) {
      setClipError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setClipBusy(false);
    }
  }

  if (!vh) return null;

  const isHolder = vh.status === "SENT_TO_EDITOR";
  const isQueued = vh.status === "QUEUED";
  const isHeld = !!vh.heldAt;
  // «Идёт отправка прямо сейчас» — то же окно, что у сервера (dispatchStartedAt
  // младше 15 минут, см. HANDOFF_DISPATCH_BUSY_WINDOW_MS в lib/videoHandoff.ts).
  const dispatching = !!vh.dispatchStartedAt && Date.now() - new Date(vh.dispatchStartedAt).getTime() < 15 * 60 * 1000;
  const delivered = vh.videos.filter((v) => v.delivered).length;
  // «Дошло N из M» и ✓/✗ — только когда отправка монтажёру уже была (13.10.2026,
  // ОБ-000160): объект в очереди ещё никому не слали, и красные ✗ «дошло 0 из 4»
  // читались как сломанная загрузка, хотя все файлы целы и просто ждут очереди.
  const showDelivery = !vh.receivedAt && (isHolder || delivered > 0 || vh.dispatchAttempts > 0);

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Монтаж</h2>
      </div>

      <p className="state">{montageStatusLine(vh)}</p>

      {vh.clipReview.status === "PENDING" && (
        <div className="mod solve">
          <div className="t">
            <b>{vh.clipReview.requestedAt ? `Ролик ждёт проверки с ${dushanbeTime(vh.clipReview.requestedAt)}` : "Ролик ждёт проверки"}</b>
          </div>
          {vh.finalVideoUrl && (
            <VideoPlayerWithFallback src={vh.finalVideoUrl} onDownload={() => window.open(vh.finalVideoUrl!, "_blank", "noopener")} />
          )}
          {canModerateClip && (
            <div className="acts" style={{ flexWrap: "wrap" }}>
              <button className="pill sm" type="button" disabled={clipBusy} onClick={() => void approveClip()}>
                {clipBusy ? "Одобряем…" : "Одобрить и запланировать"}
              </button>
              <button className="pill ghost sm" type="button" disabled={clipBusy} onClick={onSendBack}>
                Вернуть монтажёру
              </button>
            </div>
          )}
          {clipError && (
            <p className="state err" role="alert">
              <span className="dot crit" />
              {clipError}
            </p>
          )}
          {clipMessage && (
            <p className="quiet ok" role="status">
              <span className="dot ok" />
              <span className="txt">{clipMessage}</span>
            </p>
          )}
        </div>
      )}
      {vh.clipReview.status === "APPROVED" && (
        <p className="quiet ok">
          <span className="dot ok" />
          <span className="txt">
            Ролик одобрил {vh.clipReview.decidedBy ?? "модератор"}
            {vh.clipReview.decidedAt ? ` в ${dushanbeTime(vh.clipReview.decidedAt)}` : ""}
          </span>
        </p>
      )}
      {vh.clipReview.status === "REJECTED" && (
        <p className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Ролик вернул монтажёру {vh.clipReview.decidedBy ?? "модератор"}
            {vh.clipReview.comment ? `: ${vh.clipReview.comment}` : ""}
          </span>
        </p>
      )}

      {/* Плеер своего ролика — только в режиме монтажёра (25.09.2026): пока
          ролик ждёт проверки (PENDING), плеер уже нарисован выше блоком
          проверки, второй раз показывать его незачем. */}
      {isMontajerViewer && vh.finalVideoUrl && vh.clipReview.status !== "PENDING" && (
        <div className="mod solve">
          <div className="t">
            <b>Ваш ролик</b>
          </div>
          <VideoPlayerWithFallback src={vh.finalVideoUrl} onDownload={() => window.open(vh.finalVideoUrl!, "_blank", "noopener")} />
        </div>
      )}

      {queueState?.paused && isQueued && (
        <p className="quiet">
          <span className="dot" />
          <span className="txt">
            Очередь монтажёра на паузе{queueState.pauseReason ? `: ${queueState.pauseReason}` : ""}.
          </span>
        </p>
      )}

      {vh.videos.length > 0 && (
        <div className="mod solve">
          <div className="t">
            <b>
              {vh.receivedAt
                ? "Исходники"
                : showDelivery
                  ? `Исходники: дошло ${delivered} из ${vh.videos.length}`
                  : `Исходники: ${vh.videos.length}, ждут отправки монтажёру`}
            </b>
          </div>
          <ul className="list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {vh.videos.map((v) => (
              <li key={v.id} className="row">
                {showDelivery && <><span>{v.delivered ? "✓" : "✗"}</span>{" "}</>}
                <span>{v.name}</span> · <span>{formatMb(v.sizeBytes)}</span>
                {v.durationSec != null && <> · <span>{formatVideoDuration(v.durationSec)}</span></>}
                {v.hasAudio === false && <span className="chip crit sm">без звука</span>}
              </li>
            ))}
          </ul>
          {isHolder && (vh.dispatchAttempts > 1 || dispatching) && (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">
                {dispatching ? "Идёт отправка…" : `Попыток отправки: ${vh.dispatchAttempts}`}
              </span>
            </p>
          )}
        </div>
      )}

      {canQueueControl && (
        <div className="acts" style={{ flexWrap: "wrap" }}>
          {isHolder && (
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy || dispatching}
              onClick={() => resend.mutate({ propertyId: property.id })}
            >
              {dispatching ? "Уже отправляется…" : isMontajerViewer ? "Прислать исходники заново" : "Отправить повторно"}
            </button>
          )}
          {isQueued &&
            (isHeld ? (
              <button className="pill ghost sm" type="button" disabled={busy} onClick={() => unhold.mutate({ propertyId: property.id })}>
                Вернуть в очередь
              </button>
            ) : (
              <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setHolding(true)}>
                Отложить
              </button>
            ))}
          {isQueued && vh.queuePosition != null && vh.queuePosition > 2 && (
            <button className="pill ghost sm" type="button" disabled={busy} onClick={() => move.mutate({ propertyId: property.id, to: "front" })}>
              В начало очереди
            </button>
          )}
          {(isHolder || isQueued) && (
            <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setCancelling(true)}>
              Снять с монтажа
            </button>
          )}
        </div>
      )}
      {resend.isError && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {errorText(resend.error)}
        </p>
      )}
      {hold.isError && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {errorText(hold.error)}
        </p>
      )}
      {unhold.isError && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {errorText(unhold.error)}
        </p>
      )}
      {move.isError && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {errorText(move.error)}
        </p>
      )}

      {cancelling && <CancelHolderDialog id={property.id} shortId={property.shortId} onClose={() => setCancelling(false)} />}
      {holding && (
        <Rh2Sheet
          open
          onClose={() => setHolding(false)}
          dismissible={!busy}
          title={`Отложить №${property.shortId}?`}
          footer={
            <>
              <button type="button" className="pill ghost" onClick={() => setHolding(false)} disabled={busy}>
                Отмена
              </button>
              <button
                type="button"
                className="pill"
                disabled={busy}
                onClick={() =>
                  hold.mutate(
                    { propertyId: property.id, reason: holdReason.trim() || undefined },
                    { onSuccess: () => setHolding(false) }
                  )
                }
              >
                Отложить
              </button>
            </>
          }
        >
          <p className="state">Объект останется на своём месте в очереди, но место монтажёра ему пока не уйдёт.</p>
          <p className="state">
            <input
              className="inp sm"
              style={{ width: "100%" }}
              placeholder="Причина (необязательно)"
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              disabled={busy}
              aria-label="Причина придержки объекта"
            />
          </p>
        </Rh2Sheet>
      )}
    </section>
  );
}

/**
 * Агенту про ролик нужны две вещи: где он сейчас и куда вышел (ссылки, чтобы
 * отправить клиенту). Кнопки монтажа и соцсетей — работа маркетинга (решение
 * владельца 29.09.2026), поэтому агент видит одну тихую карточку без действий.
 */
export function AgentVideoStatus({ property }: { property: Property }) {
  const vh = property.videoHandoff;
  const published = effectivePublishedChannels(property);
  const links = PUBLISH_CHANNEL_ORDER.filter((c) => published.includes(c)).map((c) => ({
    channel: c,
    label: CHANNEL_NAMES[c] ?? c,
    href: publishedPostLink(c, property),
  }));
  const status = vh ? montageStatusLine(vh) : null;
  if (!status && links.length === 0) return null;
  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Ролик</h2>
      </div>
      {status && (
        <p className="quiet">
          <span className="dot" />
          <span className="txt">{status}</span>
        </p>
      )}
      {links.length > 0 && (
        <div className="acts" style={{ flexWrap: "wrap" }}>
          {links.map((l) =>
            l.href ? (
              <a key={l.channel} className="chip ok" href={l.href} target="_blank" rel="noreferrer" title={`Открыть пост: ${l.label}`}>
                <ChannelIcon channel={l.channel} tone="ink" size={13} />
                <span>{l.label}</span>
              </a>
            ) : (
              <span key={l.channel} className="chip ok">
                <ChannelIcon channel={l.channel} tone="ink" size={13} />
                <span>{l.label}</span>
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}

export function PropertyVideoFixCard({
  property,
  readOnly,
  canEdit: requestedCanEdit,
  viewer = "staff",
}: {
  property: Property;
  readOnly?: boolean;
  /**
   * Тот же расчёт, что уже питает `PropertyVideoManager` на этой же странице
   * (`PropertyDetail.tsx`, оба места монтирования) — без него любой, кто
   * просто ВИДИТ объект (не отвечает за него), получал все действия панели:
   * «Вернуть монтажёру», загрузку готового ролика, истории и «Отправить на
   * монтаж» (найдено 24.09.2026). Просмотр — «Где вышел ролик» и «Что ушло
   * монтажёру» — остаётся всем, «Убрать из соцсетей» живёт по своему гейту
   * (canUnpublish) и от этого пропа не зависит.
   */
  canEdit: boolean;
  /**
   * Режим монтажёра (25.09.2026, В1: EDITOR не видел эту панель в карточке
   * вообще — `EditorPropertyDetail` её не монтировала). `"staff"` (по
   * умолчанию) — прежняя разметка для всех остальных ролей, ни одним пикселем
   * не меняется. `"montajer"` — свой короткий набор: состояние монтажа,
   * загрузка готового ролика в своём окне (montajerMayUploadFinal), где вышел
   * ролик. Один компонент вместо второй копии — правило владельца 24.09.2026.
   */
  viewer?: "staff" | "montajer";
}) {
  const canEdit = requestedCanEdit && !property.offSite;
  const isMontajerView = viewer === "montajer";
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.agent?.role);
  const canUnpublish = role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
  /* Подключённые сети — чтобы в ходе публикации не обещать выход туда, куда ролик
     и не собирался (05.10.2026). Только тем, кому статус каналов вообще виден. */
  const { data: channelsStatus } = useChannelsStatus(canUnpublish);

  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * «ЗАГРУЗИТЬ И ВЫПУСТИТЬ СРАЗУ» (владелец 24.09.2026: «добавь кнопку, чтобы я
   * мог сразу добавлять»). Готовый ролик по умолчанию встаёт в расписание
   * публикаций; эта кнопка после приёма файла зовёт ту же «Опубликовать сейчас»
   * (POST /publish-now, lib/videoHandoff.ts::publishHandoffNow) — не второй путь
   * публикации. Право то же, что у сервера на /publish-now (маркетинг,
   * директор, админ). Поле выбора файла одно на обе кнопки — режим запоминаем
   * до открытия окна выбора.
   */
  const publishRightAway = useRef(false);
  /** Та же отметка для подписи кнопки — ref в разметке не читаем. */
  const [rightAwayLabel, setRightAwayLabel] = useState(false);
  /** Тот же список ролей, что requireMarketingRole на /publish-now. */
  const canPublishNow = canUnpublish && !property.offSite;
  /**
   * «СНАЧАЛА УБРАТЬ СТАРЫЙ РОЛИК ИЗ СОЦСЕТЕЙ» ПЕРЕД ЗАМЕНОЙ (25.09.2026, Б4).
   * Замена уходит только туда, где объект ещё не вышел: в вышедших сетях
   * остаётся старый ролик. По умолчанию включено (спецификация монтажа, пачка 2)
   * — и только у тех, кому можно «Убрать из соцсетей» (тот же гейт canUnpublish).
   * Снятие — та же POST /social-unpublish, до загрузки файла.
   */
  const [removeOldBeforeUpload, setRemoveOldBeforeUpload] = useState(false);
  /** Истории Instagram — тот же requireMarketingRole на сервере (routes/properties/
   *  videos.ts: instagram-stories-publish, instagram-story-card, -sold, story-card.jpg).
   *  До 24.09.2026 кнопки висели по одному canEdit, и ответственный агент видел
   *  целый блок, где каждое нажатие кончалось отказом. */
  const canStories = canUnpublish && !property.offSite;
  const [askDiscard, setAskDiscard] = useState(false);
  const [busy, setBusy] = useState<null | "redo" | "requeue" | "upload" | "unpublish" | "captions" | "stories" | "sold" | "card" | "publishNow" | "discard">(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /**
   * ИТОГ — ТАМ, ГДЕ НАЖАЛИ (24.09.2026, владелец с телефона: «не могу добавить
   * готовый ролик, куда-то в другое место уходит»). Ролик принимался, но строка
   * «принят» рисовалась в самом низу панели, под историями и перепиской с
   * монтажёром — на телефоне в нескольких экранах от кнопки. Рядом с кнопкой
   * не менялось ничего, и выглядело так, будто файл пропал. Загрузка и
   * «Опубликовать сейчас» стоят рядом, их итог рисуется прямо под ними.
   */
  const [resultNearUpload, setResultNearUpload] = useState(false);
  const [manual, setManual] = useState<ManualStep[]>([]);
  /** Список «руками» пришёл от снятия постов (тогда у строки есть «Удалено»)
   *  или от обновления подписи (там удалять нечего). */
  const [manualKind, setManualKind] = useState<"removal" | "captions">("removal");
  const [byHandBusy, setByHandBusy] = useState<ManualStep["channel"] | null>(null);
  const [askUnpublish, setAskUnpublish] = useState(false);
  /** Какие сети отмечены галочкой в окне «Убрать из соцсетей» (05.10.2026). */
  const [unpublishPick, setUnpublishPick] = useState<string[]>([]);
  /** Процент докачки готового ролика (23.09.2026) — null, пока не идёт ни одна
   *  часть (сессия только открывается) или загрузка не в процессе вовсе. */
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  // Диалог причины возврата монтажёру.
  const [askRedo, setAskRedo] = useState(false);
  const [redoReason, setRedoReason] = useState<VideoRemakeReason | null>(null);
  const [redoComment, setRedoComment] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const redoReasonMeta = SEND_BACK_REASONS.find((r) => r.value === redoReason) ?? null;
  const redoCommentReady = !redoReasonMeta?.commentRequired || redoComment.trim().length > 0;
  /** Переключатель «Сначала убрать старый ролик из соцсетей» (24.09.2026) —
   *  виден только тем, у кого есть гейт «Убрать из соцсетей» (canUnpublish),
   *  но состояние живёт всегда, сбрасывается вместе с остальной формой. */
  const [removeFromSocial, setRemoveFromSocial] = useState(false);

  /**
   * ИСХОДНИК ДЛЯ МОНТАЖА (22.09.2026). Сырые ролики после публикации убирает
   * уборка, и «Вернуть монтажёру» упиралось в тупик «исходники уже удалены».
   * Теперь новый исходник загружается прямо здесь, тем же многочастевым путём,
   * что и в мастере (uploadVideoNow), и форма не отправляется, пока файл не
   * собран на сервере целиком: обрыв посередине не должен стоить старых роликов.
   */
  const [sourceMode, setSourceMode] = useState<"keep" | "new">("keep");
  const [newSource, setNewSource] = useState<{ name: string; size: number } | null>(null);
  const [newSourceVideoId, setNewSourceVideoId] = useState<string | null>(null);
  const [sourceProgress, setSourceProgress] = useState<number | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const sourceInput = useRef<HTMLInputElement>(null);
  /**
   * Номер загрузочной сессии исходника (24.09.2026, гонка «закрыли окно, пока
   * грузится исходник»). `uploadVideoNow` не умеет отмену (нет AbortSignal —
   * см. lib/uploadQueue.ts) — отменяем по счётчику: каждая новая загрузка или
   * отказ от неё увеличивает `uploadSeqRef`, и когда старая загрузка всё же
   * досылается, её результат сверяет свой номер с текущим и, если они
   * разошлись, молча уходит — а если успела создать `videoId`, тут же
   * удаляет его, чтобы не оставить сироту среди исходников объекта.
   */
  const uploadSeqRef = useRef(0);
  const currentSources = useQuery({
    queryKey: ["property-videos", property.id],
    queryFn: () => api<SourceVideo[]>(`/properties/${property.id}/videos`),
    enabled: askRedo,
  });
  const keptSources = (currentSources.data ?? []).filter((v) => v.id !== newSourceVideoId);
  const hasCurrentSource = keptSources.length > 0;
  const sourceUploading = sourceProgress !== null;
  const sourceReady = sourceMode === "keep" ? hasCurrentSource : !!newSourceVideoId && !sourceUploading;

  /**
   * Исходников на сервере нет (их убрали после публикации) — «Оставить текущий»
   * выключен, и человек по умолчанию стоял на мёртвом варианте: кнопка
   * отправки не оживала, пока он сам не догадается щёлкнуть «Загрузить новый».
   * Переключаем за него, как только список исходников пришёл пустым.
   */
  useEffect(() => {
    if (askRedo && currentSources.isSuccess && !hasCurrentSource && sourceMode === "keep") setSourceMode("new");
  }, [askRedo, currentSources.isSuccess, hasCurrentSource, sourceMode]);

  /**
   * ПОЧЕМУ КНОПКА НЕ НАЖИМАЕТСЯ — словами (владелец 24.09.2026: загрузил новый
   * ролик, а «Отправить монтажёру» серая, и ни слова почему). Кнопку по-прежнему
   * блокируем, а не ругаемся после нажатия (§ «блокируй кнопку»), но рядом с ней
   * всегда стоит одна строка с тем единственным, чего не хватает — в порядке
   * полей формы сверху вниз.
   */
  const sendBackBlocker: string | null = !redoReason
    ? "Осталось выбрать, что не так."
    : !redoCommentReady
      ? "Для этой причины нужен комментарий."
      : sourceUploading
        ? `Исходник ещё загружается — ${sourceProgress}%.`
        : !sourceReady
          ? sourceMode === "new"
            ? "Осталось выбрать видео для монтажа."
            : "Исходников на сервере нет — загрузите новый."
          : null;

  /**
   * Предпросмотр текста, который уйдёт монтажёру (владелец 20.09.2026: «я
   * хочу, чтобы я видел, что отправляется монтажёру, а то бывали ошибки, я
   * каждый раз скриншот у него просил»). Текст собирает СЕРВЕР
   * (`GET .../montajer-preview`), не фронт — своя сборка разошлась бы с
   * настоящей отправкой и показывала бы владельцу красивое враньё.
   * Перезапрашивается с задержкой при каждой смене причины/комментария, пока
   * диалог открыт и обязательный комментарий (если он обязателен) заполнен.
   */
  useEffect(() => {
    if (!askRedo || !redoReason || !redoCommentReady) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ reason: redoReason });
      const trimmed = redoComment.trim();
      if (trimmed) q.set("comment", trimmed);
      api<{ text: string }>(`/properties/${property.id}/montajer-preview?${q.toString()}`)
        .then((r) => {
          if (!cancelled) setPreview(r.text);
        })
        .catch((err) => {
          if (!cancelled) setPreviewError(err instanceof Error ? err.message : "Не удалось собрать текст");
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [askRedo, redoReason, redoComment, redoCommentReady, property.id]);

  /**
   * «Что ушло монтажёру» (владелец 20.09.2026: «я хочу видеть, что
   * отправляется ему вообще» — до сих пор просил у монтажёра скриншот
   * переписки каждый раз). Свёрнуто по умолчанию и грузится ЛЕНИВО, ровно
   * как разговор в хронологии клиента (InteractionTimeline.tsx) — история
   * нужна владельцу, когда что-то пошло не так, а не при каждом открытии
   * карточки.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  const {
    data: history,
    isLoading: historyLoading,
    error: historyErr,
  } = useQuery({
    queryKey: ["montajer-messages", property.id],
    // Сервер отдаёт обёртку `{ messages }`, а не голый массив: у роута есть
    // предел выборки, и рядом с ним со временем встанут «всего» и курсор —
    // разворачиваем здесь, чтобы разметка ниже знала только про список.
    queryFn: () =>
      api<{ messages: MontajerMessage[] }>(`/properties/${property.id}/montajer-messages`).then((r) => r.messages),
    enabled: historyOpen,
    staleTime: 30_000,
  });

  /**
   * «Когда выкладывали в истории последний раз» (21.09.2026) — рядом с кнопкой
   * «Выложить в истории», чтобы не гадать, публиковали ли уже сегодня. История
   * — не то же самое, что Property.publishedChannels (та про ленту, живёт,
   * пока не снимут; история пропадает сама через 24 часа) — отдельный запрос,
   * отдельный ключ кэша.
   */
  const { data: lastStory } = useQuery({
    queryKey: ["instagram-stories-last", property.id],
    queryFn: () =>
      api<{ lastPublishedAt: string | null; channel: string | null }>(`/properties/${property.id}/instagram-stories/last`),
    enabled: !!property.videoHandoffFinalPath,
    staleTime: 30_000,
  });

  /** Клавиатура в обеих radiogroup диалога «Вернуть монтажёру» (24.09.2026,
   *  п.7 задания) — до ранних `return null` выше, как и остальные хуки: вызов
   *  не может зависеть от того, дошёл ли рендер до диалога. */
  const reasonRoving = useRovingRadio(VIDEO_REMAKE_REASONS, redoReason);
  const sourceRoving = useRovingRadio(SOURCE_MODES, sourceMode, (v) => (v === "keep" ? !hasCurrentSource || sourceUploading : sourceUploading));

  const published = effectivePublishedChannels(property);
  /** Кросспостинг Facebook (28.09.2026, lib/facebookCrosspost.ts) — значение
   *  пишет crosspostAfterFacebookPublish, форма объекта — не строка, как у
   *  остальных ключей publishedPostIds, каст только здесь, на чтении. */
  const facebookCrosspost = property.publishedPostIds?.FACEBOOK_CROSSPOST as unknown as
    | { allowed: string[]; at: string }
    | undefined;
  /* Ролик стоит на проверке модератора (25.09.2026) — сервер отклоняет
     «Опубликовать сейчас»/«Перенести» 409, пока clipReview не решён; гасим
     кнопку заранее, а не после отказа (§ «блокируй кнопку»). */
  const clipReviewPending = property.videoHandoff?.clipReview.status === "PENDING";
  if (readOnly) return null;
  /* Блок рисуется у ЛЮБОГО объекта, а не в корзине (07.10.2026, владелец: «чтобы во всех
     объектах, старых и новых, были все кнопки»). До этого объект без отмеченных сетей и
     без файла готового ролика сворачивался до одних историй (или до пустоты), и кнопки
     пропадали у старых объектов, выложенных до конвейера: 88 чинили ссылкой Instagram,
     82 всё равно остался без кнопок. Что кнопка может сделать с таким объектом, говорит
     сервер понятной причиной, а прятать её нельзя.
     «Ссылка вписана руками» — только подсказка в блоке «Где вышел ролик»: сети за ней
     не выдумываем (published не трогаем). */
  const manualVideoLink = hasManualVideoLink(property.instagramUrl) ? property.instagramUrl!.trim() : null;
  /* Ролика у объекта нет вовсе — тогда рядом с общим блоком нужен блок фото-поста. */
  const noClip = published.length === 0 && !property.videoHandoffFinalPath;

  async function refresh() {
    /* ОДИН КЛЮЧ ВМЕСТО ДВУХ ТОЧНЫХ (21.09.2026). Карточка объекта кэшируется
       под ["property", id-из-адреса] — это СТРОКА ("113"), её кладёт useParams
       (hooks/useProperties.ts::useProperty). Ни ["property", property.shortId]
       (число 113), ни ["property", property.id] (UUID) с ней не совпадают, и
       перезапроса не было вовсе: человек нажимал кнопку, сервер отрабатывал, а
       экран продолжал показывать прежнее состояние. Владелец 21.09: «после
       отправки неактивные данные должны исчезнуть, и это касается всей
       карточки». Префикс ["property"] накрывает карточку при любом виде id —
       ровно так и делает весь остальной useProperties.ts. */
    await qc.invalidateQueries({ queryKey: ["property"] });
    await qc.invalidateQueries({ queryKey: ["properties"] });
    // Новое сообщение монтажёру — история, если открыта, обязана его увидеть
    // без ручного перезахода в свёрнутый блок.
    await qc.invalidateQueries({ queryKey: ["montajer-messages", property.id] });
    await qc.invalidateQueries({ queryKey: ["instagram-stories-last", property.id] });
  }

  /** Один и тот же каркас на все четыре действия: обнулить прошлый итог,
   *  показать работу в тексте кнопки, показать честный результат, обновить
   *  карточку. Четыре копии этого кода разъехались бы на первой же правке. */
  async function run<T>(kind: NonNullable<typeof busy>, call: () => Promise<T>, describe: (r: T) => string) {
    setError(null);
    setDone(null);
    setManual([]);
    setResultNearUpload(kind === "publishNow");
    setBusy(kind);
    try {
      const result = await call();
      setDone(describe(result));
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз";
      setError(message);
      // Исходников на сервере нет — вместо тупика сразу открываем загрузку нового.
      if (/исходн\S* ролик\S* .*удален/i.test(message)) setSourceMode("new");
    } finally {
      setBusy(null);
    }
  }

  /**
   * «УДАЛЕНО» (24.09.2026). Instagram без ключа удаления и TikTok всегда не дают
   * снять пост программой, и площадка оставалась «занятой» навсегда: новый ролик
   * туда больше не уходил. Человек удаляет пост в приложении и отмечает это здесь.
   */
  async function confirmRemovedByHand(channel: ManualStep["channel"]) {
    setError(null);
    setDone(null);
    setByHandBusy(channel);
    try {
      const r = await api<{ changed: boolean; willPublish: boolean; publishRunning?: boolean }>(
        `/properties/${property.id}/social-removed-by-hand`,
        { method: "POST", body: { channel } }
      );
      setManual((steps) => steps.filter((step) => step.channel !== channel));
      const name = CHANNEL_NAMES[channel] ?? channel;
      // Готовый ролик на сервере уже есть и публикация не идёт — выкладываем заново сразу
      // (05.10.2026, владелец: «чтобы CRM заново это добавила»), а не ждём отдельного нажатия.
      let republished = false;
      if (r.changed && !r.willPublish && !r.publishRunning && channel !== "TIKTOK" && property.videoHandoffFinalPath && canPublishNow) {
        try {
          await api<{ ok: boolean }>(`/properties/${property.id}/publish-now`, { method: "POST" });
          republished = true;
        } catch {
          /* сообщение ниже подскажет нажать вручную */
        }
      }
      setDone(
        republished
          ? `${name}: отмечено, ролик выкладывается заново — минута-две.`
          : r.publishRunning
            ? `${name}: отмечено. Сейчас идёт публикация — как закончится, нажмите «Опубликовать сейчас», и ролик выйдет и туда.`
            : r.willPublish
              ? `${name}: отмечено. Новый ролик уйдёт туда в свой час.`
              : channel === "TIKTOK"
                ? `${name}: отмечено. Новый ролик выложите кнопкой «Опубликовать в TikTok».`
                : `${name}: отмечено. Нажмите «Опубликовать сейчас», чтобы ролик вышел и туда.`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setByHandBusy(null);
    }
  }

  /**
   * ЗАГРУЗКА ГОТОВОГО РОЛИКА — ЧЕРЕЗ ДОКАЧКУ С СЕРЕДИНЫ (23.09.2026), а не
   * одним запросом FormData, как раньше: большой ролик (гигабайты в исходном
   * качестве от монтажёра) упирался в потолок одного запроса и в обрыв связи
   * без возможности продолжить. `uploadVideoChunked` — та же функция, что
   * шлёт сырые видео объекта (lib/uploadQueue.ts), просто с purpose="handoff":
   * сервер сам решает, что сделать с собранным файлом (routes/properties/videos.ts).
   *
   * Свой повтор с нарастающей паузой (не `run()` выше — та не даёт процента и
   * не отличает «сеть моргнула» от «отказ навсегда»), тот же приём, что и в
   * очереди (retryDelayMs/MAX_RETRY_ATTEMPTS, run() в lib/uploadQueue.ts):
   * обрыв связи/5xx/429 — повтор с тем же uploadKey (сервер продолжит с
   * недостающих частей, а не с нуля), другая ошибка — стоп сразу.
   */
  async function handleUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setDone(null);
    setManual([]);
    setResultNearUpload(true);
    setBusy("upload");
    setUploadPercent(0);
    const uploadKey = crypto.randomUUID();
    try {
      // Снять старый ролик ДО загрузки (25.09.2026, Б4): иначе замена встанет
      // рядом с ним, а не вместо. Отказ снятия (идёт публикация — 409) — стоп:
      // загружать поверх ролика, который прямо сейчас выходит, нельзя.
      let removalNote = "";
      if (canUnpublish && removeOldBeforeUpload && published.length > 0) {
        try {
          const removal = await api<RemovalResult>(`/properties/${property.id}/social-unpublish`, { method: "POST" });
          setManual(removal.manual);
          setManualKind("removal");
          const parts = removalParts(removal);
          if (parts.length > 0) removalNote = ` Старый ролик: ${parts.join(". ")}.`;
        } catch (err) {
          setError(`Старый ролик убрать не получилось (${err instanceof Error ? err.message : "ошибка"}) — новый не загружали.`);
          return;
        }
      }
      let attempts = 0;
      for (;;) {
        attempts++;
        const result = await uploadVideoChunked(
          { propertyId: property.id, file, uploadKey, filename: file.name, purpose: "handoff" },
          (loaded, total) => setUploadPercent(total > 0 ? Math.round((loaded / total) * 100) : 0)
        );
        if (result.status >= 200 && result.status < 300) {
          const body = result.data as
            | {
                publishSummary: { succeededChannels?: string[] } | null;
                scheduledPublishAt?: string | null;
                notPublishingReason?: string | null;
                clipReviewPending?: boolean;
                oldVideoLeftIn?: string[];
              }
            | undefined;
          const ok = body?.publishSummary?.succeededChannels ?? [];
          // Ролик уходит в сети не сразу, а в свой час расстановки (с 21.09.2026,
          // lib/publishSchedule.ts на сервере) — время называем здесь же, иначе
          // «принят» без него читается как «пропал». Если сам он не уйдёт никуда
          // (автопубликация выключена, объект вне продажи, везде уже вышел),
          // сервер говорит почему — это и показываем вместо часа (24.09.2026).
          const at = body?.scheduledPublishAt;
          const notPublishing = body?.notPublishingReason;
          let message =
            ok.length > 0
              ? `Новый ролик принят и опубликован: ${channelList(ok)}.`
              : notPublishing
                ? `Новый ролик принят. ${notPublishing}`
                : at
                  ? `Новый ролик принят. В сети уйдёт ${dushanbeDateTime(at)}.`
                  : "Новый ролик принят.";
          if (publishRightAway.current && ok.length === 0 && !notPublishing) {
            try {
              // «Выпустить сразу» не должно упираться в проверку модератора (05.10.2026):
              // тот, кто жмёт эту кнопку, и решает — ролик одобряется тем же вызовом, что
              // кнопка «Одобрить», и сразу идёт в публикацию. Нет права модерации —
              // сервер ответит отказом, и ниже человек увидит, что ролик ждёт проверки.
              if (body?.clipReviewPending) {
                await api(`/properties/${property.id}/clip-review/approve`, { method: "POST" });
              }
              await api<{ ok: boolean }>(`/properties/${property.id}/publish-now`, { method: "POST" });
              message = "Новый ролик принят и уходит в сети прямо сейчас — минута-две.";
            } catch (err) {
              // Ролик уже принят — отказ «выпустить сразу» его не отменяет:
              // остаётся расписание, и мы честно говорим обе вещи.
              const why = err instanceof Error ? err.message : "не получилось";
              message = `${message} Сразу выпустить не вышло: ${why}`;
            }
          }
          // Где остался СТАРЫЙ ролик — сервер говорит это после приёма (Б4).
          const oldLeft = body?.oldVideoLeftIn ?? [];
          if (oldLeft.length > 0) {
            message = `${message} В ${channelList(oldLeft)} остался старый ролик — туда новый сам не уйдёт, сначала «Убрать из соцсетей».`;
          }
          setDone(`${message}${removalNote}`);
          await refresh();
          break;
        }
        // Обрыв связи (0), 5xx и 429 — сторона сети/сервера, повторяем с той же
        // uploadKey (докачка с середины подхватит недостающие части сама).
        // Прочее (403/409/400) — сторона файла/прав/состояния объекта, повтор
        // не изменит ничего.
        const retryable = result.status === 0 || result.status >= 500 || result.status === 429;
        if (!retryable || attempts >= MAX_RETRY_ATTEMPTS) {
          setError(
            attempts >= MAX_RETRY_ATTEMPTS && retryable
              ? `Не ушло за ${attempts} попыток — проверьте связь и повторите.`
              : result.error ?? httpStatusMessage(result.status)
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempts)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(null);
      setUploadPercent(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function resetSource() {
    setSourceMode("keep");
    setNewSource(null);
    setNewSourceVideoId(null);
    setSourceProgress(null);
    setSourceError(null);
    if (sourceInput.current) sourceInput.current.value = "";
  }

  async function pickNewSource(file: File | undefined) {
    if (!file) return;
    // Прошлый загруженный, но не отправленный файл заменяется новым — убираем
    // его и отменяем его же загрузку, если она ещё шла (bump uploadSeqRef).
    discardUnsentSource();
    setSourceError(null);
    setNewSource({ name: file.name, size: file.size });
    setNewSourceVideoId(null);
    setSourceProgress(0);
    const seq = ++uploadSeqRef.current;
    const result = await uploadVideoNow(property.id, file, (loaded, total) => {
      if (uploadSeqRef.current !== seq) return; // отменено — прогресс уже никому не нужен
      setSourceProgress(total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0);
    });
    if (uploadSeqRef.current !== seq) {
      // Загрузку отменили, пока она шла (закрыли окно/выбрали другой файл),
      // но сервер всё же успел собрать файл — не оставляем сироту.
      if (result.ok) void api(`/properties/${property.id}/videos/${result.videoId}`, { method: "DELETE" }).catch(() => {});
      return;
    }
    setSourceProgress(null);
    if (result.ok) {
      setNewSourceVideoId(result.videoId);
    } else {
      setSourceError(result.error);
      setNewSource(null);
    }
    if (sourceInput.current) sourceInput.current.value = "";
  }

  /** Отмена загрузки исходника кнопкой рядом с прогрессом (24.09.2026) — не
   *  ошибка, а осознанный отказ: тихо возвращаем форму в состояние «файл не
   *  выбран», сирота (если успеет создаться) подчистится сама в pickNewSource. */
  function cancelSourceUpload() {
    uploadSeqRef.current++;
    setSourceProgress(null);
    setNewSource(null);
    setNewSourceVideoId(null);
    setSourceError(null);
    if (sourceInput.current) sourceInput.current.value = "";
  }

  /** Новый исходник загрузили, но объект так и не отправили — убираем его,
   *  иначе он молча лёг бы рядом со старыми роликами и ушёл бы при следующей
   *  обычной передаче. Лучшее усилие: права те же, что у DELETE видео.
   *  Заодно отменяет незавершённую загрузку (см. uploadSeqRef выше). */
  function discardUnsentSource() {
    uploadSeqRef.current++;
    if (newSourceVideoId) {
      void api(`/properties/${property.id}/videos/${newSourceVideoId}`, { method: "DELETE" }).catch(() => {});
    }
  }

  function openSendBack() {
    resetSource();
    setRedoReason(null);
    setRedoComment("");
    setRemoveFromSocial(false);
    setPreview(null);
    setPreviewError(null);
    setAskRedo(true);
  }

  /**
   * `keepSource` — исходник уже привязан к объекту отправкой (24.09.2026,
   * проверка по классам): `handleSendBack` звал закрытие из того же рендера,
   * где `newSourceVideoId` ещё хранил id только что отправленного ролика, —
   * `setNewSourceVideoId(null)` до закрытия не доходит, — и «уборка
   * неотправленного» тут же удаляла свежий исходник с сервера. Монтажёр,
   * до которого очередь доходила позже, получал объект без видео.
   */
  function closeSendBack(opts: { keepSource?: boolean } = {}) {
    if (!opts.keepSource) discardUnsentSource();
    else uploadSeqRef.current++;
    resetSource();
    setAskRedo(false);
    setRedoReason(null);
    setRedoComment("");
    setRemoveFromSocial(false);
    setPreview(null);
    setPreviewError(null);
  }

  /**
   * Не переиспользует `run()`: та закрывает диалог до ответа сервера
   * (годится для остальных трёх действий панели), а здесь диалог обязан
   * остаться открытым при отказе — «Исходные ролики уже удалены…» человек
   * должен прочитать рядом с формой, а не гадать, куда делось окно, и
   * поправить причину/комментарий, не выбирая их заново.
   */
  async function handleSendBack() {
    if (!redoReason) return;
    setError(null);
    setDone(null);
    setManual([]);
    setBusy("redo");
    try {
      const response = await api<{ queued: boolean; social?: RemovalResult }>(
        `/properties/${property.id}/send-back-to-montajer`,
        {
          method: "POST",
          body: {
            reason: redoReason,
            comment: redoComment.trim() || undefined,
            replaceVideoIds: sourceMode === "new" && newSourceVideoId ? [newSourceVideoId] : undefined,
            removeFromSocial: removeFromSocial ? true : undefined,
          },
        }
      );
      // Исходник принят и привязан к объекту — закрытие окна его больше не удаляет.
      setNewSourceVideoId(null);
      await refresh();
      void qc.invalidateQueries({ queryKey: ["property-videos", property.id] });
      // Одна короткая строка (владелец 20.09.2026): «просто надо написать
      // успешно отправлено, и всё, а не перечислять, что где куда пошло» —
      // плюс итог снятия из соцсетей, если его просили (24.09.2026), той же
      // строкой, что и у кнопки «Убрать из соцсетей».
      const parts = ["Отправлено монтажёру"];
      if (response.social) {
        setManual(response.social.manual);
        setManualKind("removal");
        parts.push(...removalParts(response.social));
      }
      setDone(`${parts.join(". ")}.`);
      closeSendBack({ keepSource: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(null);
    }
  }

  /* Кнопки историй — единственная часть карточки, которой ролик не нужен:
     они же показываются отдельным блоком объекту без ролика (storiesOnly). */
  const storyBlocks = (
    <>
      {/* Карточка объекта в истории (владелец 21.09.2026: «как быть с объектами,
          как их в историю добавлять»). Ролик для этого не нужен — картинка
          рисуется по главному фото, поэтому блок живёт отдельно от ролика. */}
      <div className="mod solve">
        <div className="t">
          <b>Карточку объекта в истории</b>
          <span>
            Главное фото с ценой, районом и номером объекта — одной историей в Instagram. Ролик для этого не нужен.
          </span>
        </div>
        <div className="acts">
          <button
            className="pill ghost sm"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              run(
                "card",
                () =>
                  api<{ ok: boolean; error?: string | null }>(`/properties/${property.id}/instagram-story-card`, {
                    method: "POST",
                  }),
                (r) => {
                  if (!r.ok) throw new Error(r.error ?? "Не удалось выложить карточку в истории");
                  return "Карточка объекта выложена в истории.";
                }
              )
            }
          >
            {busy === "card" ? "Публикуем…" : "Выложить карточку"}
          </button>
          <StoryCardPreview propertyId={property.id} />
        </div>
      </div>
      {/* Печать «ПРОДАНО» (владелец 21.09.2026: «типа печать поставить типа
          продано, как в других компаниях делают»). Ролик не нужен — карточка
          рисуется по главному фото, поэтому кнопка живёт отдельно от блока
          «Выложить в истории» и видна у объекта без ролика тоже. */}
      {property.status === "SOLD" && (
        <div className="mod solve">
          <div className="t">
            <b>Печать «Продано» в истории</b>
            <span>
              Главное фото объекта с оттиском «ПРОДАНО» — одной историей в Instagram. В ленте пост остаётся как был:
              историю Instagram удаляет сама через сутки.
            </span>
          </div>
          <div className="acts">
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "sold",
                  () =>
                    api<{ ok: boolean; error?: string | null }>(`/properties/${property.id}/instagram-story-sold`, {
                      method: "POST",
                    }),
                  (r) => {
                    if (!r.ok) throw new Error(r.error ?? "Не удалось выложить печать в истории");
                    return "Печать «Продано» выложена в истории.";
                  }
                )
              }
            >
              {busy === "sold" ? "Публикуем…" : "Выложить печать «Продано»"}
            </button>
          </div>
        </div>
      )}
    </>
  );

  const resultBanners = (
    <>
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
          <button className="lnk" type="button" onClick={() => setError(null)}>
            Понятно
          </button>
        </div>
      )}
      {done && (
        <div className="quiet ok" role="status">
          <span className="dot ok" />
          <span className="txt">{done}</span>
        </div>
      )}
    </>
  );

  /* «Где вышел ролик» — вынесено в константу (25.09.2026, панель монтажёра):
     тот же блок нужен и в staff-разметке ниже, и в ветке isMontajerView, без
     второй копии разметки. */
  const publishState = property.videoHandoff?.publish?.state ?? "idle";
  const publishRunning = publishState === "running";
  const publishWaiting = publishState === "waiting" || publishState === "retrying";
  /* Сеть ждёт публикации: задание идёт или стоит в расписании, канал подключён
     (если статус каналов нам известен) и ещё не вышел. */
  const channelExpected = (channel: string) => {
    const connected = (channelsStatus?.channels as Record<string, { connected?: boolean }> | undefined)?.[channel]?.connected;
    return connected !== false;
  };
  const progressDone = PUBLISH_CHANNEL_ORDER.filter((c) => published.includes(c));
  const progressLeft = PUBLISH_CHANNEL_ORDER.filter((c) => !published.includes(c) && !property.publishErrors?.[c] && channelExpected(c));
  const publishedChannelsBlock = (
    <div className="mod solve">
      <div className="t">
        <b>Где вышел ролик</b>
        <span>Сети — галочка, где уже опубликовано, «не ушло» — где пытались и не вышло.</span>
        {published.length === 0 && manualVideoLink && (
          <span className="quiet" style={{ marginTop: 4 }}>
            <span className="dot" />
            <span className="txt">
              Ролик выложен вручную:{" "}
              {/^https?:\/\//i.test(manualVideoLink) ? (
                <a href={manualVideoLink} target="_blank" rel="noreferrer">
                  {manualVideoLink}
                </a>
              ) : (
                manualVideoLink
              )}
              . CRM не может сама убрать такой пост — удалите его там, где он лежит, и тогда перемонтаж или новый ролик не
              оставят старый рядом.
            </span>
          </span>
        )}
        {publishRunning && (
          <span className="quiet" role="status" aria-live="polite" style={{ marginTop: 4 }}>
            <span className="dot" />
            <span className="txt">
              Публикуем прямо сейчас: вышло {progressDone.length}
              {progressLeft.length > 0 ? `, осталось ${channelList(progressLeft)}` : ""}. Страница обновляется сама.
            </span>
          </span>
        )}
        {publishWaiting && (
          <span className="quiet" role="status" style={{ marginTop: 4 }}>
            <span className="dot" />
            <span className="txt">
              {publishState === "retrying"
                ? `Прошлая попытка не удалась, повтор в ${dushanbeTime(property.videoHandoff!.publish!.runAt!)}.`
                : `Публикация в сети в очереди: выйдет в ${dushanbeTime(property.videoHandoff!.publish!.runAt!)}.`}
              {progressLeft.length > 0 ? ` Ждут: ${channelList(progressLeft)}.` : ""}
            </span>
          </span>
        )}
      </div>
      <div className="acts" style={{ flexWrap: "wrap" }}>
        {PUBLISH_CHANNEL_ORDER.map((channel) => {
          const isPublished = published.includes(channel);
          const failMessage = property.publishErrors?.[channel];
          const link = isPublished ? publishedPostLink(channel, property) : null;
          const label = CHANNEL_NAMES[channel] ?? channel;
          if (isPublished) {
            const content = (
              <>
                <ChannelIcon channel={channel} tone="ink" size={13} />
                <span>{label}</span>
                <Check size={12} aria-hidden />
              </>
            );
            return link ? (
              <a key={channel} className="chip ok" href={link} target="_blank" rel="noreferrer" title={`Открыть пост: ${label}`}>
                {content}
              </a>
            ) : (
              <span key={channel} className="chip ok">
                {content}
              </span>
            );
          }
          if (failMessage) {
            return (
              <span key={channel} className="chip crit" title={failMessage}>
                <ChannelIcon channel={channel} tone="ink" size={13} />
                <span>{label}</span>
                <X size={12} aria-hidden />
                <span>не ушло</span>
              </span>
            );
          }
          // Идёт публикация, и эта сеть ещё впереди — видно, что она в процессе, а не
          // «не собирались» (05.10.2026).
          if (publishRunning && channelExpected(channel)) {
            return (
              <span key={channel} className="chip" title={`${label}: публикуется или ждёт своей очереди`}>
                <ChannelIcon channel={channel} tone="ink" size={13} />
                <span>{label}</span>
                <span aria-hidden>…</span>
              </span>
            );
          }
          // Не публиковали и не пытались — приглушённо, без тревоги: могли и
          // не собираться туда публиковать (см. §3 задачи).
          return (
            <span key={channel} className="chip mute">
              <ChannelIcon channel={channel} tone="ink" size={13} />
              <span>{label}</span>
            </span>
          );
        })}
      </div>
      {facebookCrosspost && facebookCrosspost.allowed.length > 0 && (
        <div className="quiet" style={{ marginTop: "var(--s2)" }}>
          <span className="dot" />
          <span className="txt">Кросспостинг разрешён для {facebookCrosspost.allowed.length} Страниц</span>
        </div>
      )}
    </div>
  );

  /* «Загрузить готовый ролик» — та же вынесенная константа (25.09.2026).
     Показ — не canEdit напрямую, а canUploadFinal: у staff это ровно canEdit
     (разметка не сдвигается ни на пиксель), в режиме монтажёра — всегда true,
     а решает, показывать ли этот блок вообще, сама ветка isMontajerView
     (montajerMayUploadFinal). Текст описания различается: у монтажёра нет
     смысла говорить про расписание/сети так же, как агенту. */
  const canUploadFinal = !property.offSite && (isMontajerView ? true : canEdit);
  const finalUploadBlock = (
    <>
      {canUploadFinal && (
        <div className="mod solve">
          <div className="t">
            <b>Загрузить готовый ролик</b>
            <span>
              {isMontajerView ? (
                "Смонтированный ролик целиком — CRM примет его так же, как из бота, и поставит на проверку или в расписание."
              ) : (
                <>
                  Если правильный ролик уже есть на руках — он сам разойдётся по сетям, где объект ещё не вышел.
                  {canPublishNow ? " Сразу — или в ближайший удачный час по расписанию." : " В ближайший удачный час по расписанию."}
                </>
              )}
            </span>
          </div>
          <div className="acts">
            {canPublishNow && (
              <button
                className="pill sm"
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  publishRightAway.current = true;
                  setRightAwayLabel(true);
                  fileInput.current?.click();
                }}
              >
                {busy === "upload" && rightAwayLabel ? `Загружаем… ${uploadPercent ?? 0}%` : "Загрузить и выпустить сразу"}
              </button>
            )}
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy !== null}
              onClick={() => {
                publishRightAway.current = false;
                setRightAwayLabel(false);
                fileInput.current?.click();
              }}
            >
              {busy === "upload" && !rightAwayLabel
                ? `Загружаем… ${uploadPercent ?? 0}%`
                : canPublishNow
                  ? "По расписанию"
                  : "Выбрать файл"}
            </button>
          </div>
          {/* СТАРЫЙ РОЛИК В ВЫШЕДШИХ СЕТЯХ (25.09.2026, Б4): замена туда не
              доходит (сервер пропускает вышедшие каналы) — говорим это до
              загрузки, а маркетингу даём снять старый тем же движением. */}
          {published.length > 0 && (
            <div className="why">
              <p className="state">
                <span className="dot warn" aria-hidden />
                {canUnpublish && removeOldBeforeUpload
                  ? `Перед загрузкой уберём старый ролик из ${channelList(published)} — новый уйдёт туда сам.`
                  : `В ${channelList(published)} останется старый ролик — сначала «Убрать из соцсетей».`}
              </p>
              {canUnpublish && (
                <div className="list" role="group" aria-label="Убрать старый ролик перед загрузкой">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={removeOldBeforeUpload}
                    className="row wrapt"
                    disabled={busy !== null}
                    onClick={() => setRemoveOldBeforeUpload((v) => !v)}
                  >
                    <span className={removeOldBeforeUpload ? "dot ok" : "dot"} aria-hidden />
                    <span className="t">
                      <b>Сначала убрать старый ролик из соцсетей</b>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {canUploadFinal && <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => void handleUpload(e.target.files)} />}
      {resultNearUpload && resultBanners}
    </>
  );

  /* СНОВА НА МОНТАЖ (23.09.2026, №121). Объект сняли с монтажа, готового ролика
     нет, в очереди его нет — раньше на карточке не было ни одной кнопки, которая
     вернула бы его монтажёру: «Вернуть монтажёру» ниже про уже вышедший ролик.
     Условия те же, что проверяет сервер (lib/videoHandoff.ts::requeueVideoHandoff);
     сервер всё равно проверит сам и ответит понятной причиной. */
  const canRequeue =
    property.status === "EDITING" &&
    !property.videoHandoffFinalPath &&
    (property.videoHandoffStatus == null ||
      property.videoHandoffStatus === "NONE" ||
      property.videoHandoffStatus === "RECEIVED" ||
      // Объект «открыт вручную под готовый ролик», а ролик так и не пришёл —
      // сервер разрешает вернуть его в очередь, и кнопка обязана быть (24.09.2026).
      (property.videoHandoffStatus === "SENT_TO_EDITOR" && !!property.videoHandoffManualSince)) &&
    (property.videoCount ?? 0) > 0;
  /* «Вернуть монтажёру» активна, когда объект уже у монтажёра (24.09.2026,
     найдено живой проверкой): QUEUED — стоит в очереди, SENT_TO_EDITOR — уже
     у него, и в обоих случаях возврат про ролик, который ещё не вышел, — но
     кнопка была рабочей всегда. Ручное ожидание (videoHandoffManualSince)
     здесь не отличаем: сервер отказывает в возврате при любом SENT_TO_EDITOR. */
  const atEditor = property.videoHandoffStatus === "QUEUED" || property.videoHandoffStatus === "SENT_TO_EDITOR";
  /* «Публикация запланирована» — и у уже вышедшего объекта, пока его новый
     ролик ждёт своего часа (24.09.2026, см. lib/publishPlanned.ts). */
  const publishPlanned = isPublishPlanned(property, Date.now());

  /**
   * ВЕТКА МОНТАЖЁРА (25.09.2026, В1 спецификации) — короткий набор вместо
   * всей staff-разметки ниже: состояние монтажа, загрузка готового ролика в
   * своём окне (montajerMayUploadFinal — то же правило, что и на сервере,
   * finalReopenDeniedReason в routes/properties/videos.ts), где вышел ролик.
   * Все хуки уже вызваны выше — ранний return после них не нарушает их
   * порядок между рендерами.
   */
  if (isMontajerView) {
    const mayUpload = montajerMayUploadFinal(
      {
        videoHandoffStatus: property.videoHandoffStatus,
        receivedAt: property.videoHandoff?.receivedAt,
        publishedChannels: published,
      },
      Date.now()
    );
    return (
      <>
        {property.videoHandoffStatus && property.videoHandoffStatus !== "NONE" && (
          <MontageBlock property={property} canEdit={false} viewer="montajer" onSendBack={() => {}} />
        )}
        <section className="card">
          <div className="sec-h stack">
            <h2>Готовый ролик</h2>
          </div>
          {mayUpload ? (
            finalUploadBlock
          ) : (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">
                Загрузить ролик можно, когда объект у вас на монтаже, или в течение 3 часов после приёма, пока он не вышел в сети.
              </span>
            </p>
          )}
          {published.length > 0 && publishedChannelsBlock}
          {!resultNearUpload && resultBanners}
        </section>
      </>
    );
  }

  return (
    <>
      {property.videoHandoffStatus && property.videoHandoffStatus !== "NONE" && (
        <MontageBlock property={property} canEdit={canEdit} onSendBack={openSendBack} />
      )}
      {canRequeue && (
        <section className="card">
          <div className="mod solve">
            <div className="t">
              <b>Отправить на монтаж</b>
              <span>Объект сняли с монтажа, а готового ролика так и нет. Сырое видео уйдёт монтажёру или встанет в очередь.</span>
            </div>
            <div className="acts">
              <button
                className="pill sm"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "requeue",
                    () => api<{ queued: boolean }>(`/properties/${property.id}/video-handoff/requeue`, { method: "POST" }),
                    (r) => (r.queued ? "Поставлено в очередь монтажёру." : "Отправлено монтажёру.")
                  )
                }
              >
                {busy === "requeue" ? "Отправляем…" : "Отправить на монтаж"}
              </button>
            </div>
          </div>
        </section>
      )}
      <section className="card">
      <div className="sec-h stack">
        <h2>Ролик и соцсети</h2>
        <span className="note">{property.offSite ? "Только для своих клиентов: новые публикации в соцсетях запрещены." : "Если с роликом что-то не так, карточку заполнять заново не нужно"}</span>
      </div>

      {publishedChannelsBlock}

      {/* РОЛИК ПРИНЯТ ПО ОШИБКЕ (09.10.2026, №154 держал ролик №153): совпадение
          готовых роликов ищется по файлу на диске, и пока ошибочная карточка
          держит файл, правильная его не примет — «Вернуть монтажёру» путь не
          стирает. Кнопка снимает ролик с карточки и ждущую публикацию; посты
          в сетях не трогает, об этом говорит итог. */}
      {canUnpublish && property.videoHandoffFinalPath && (
        <div className="mod solve">
          <div className="t">
            <b>Ролик принят по ошибке</b>
            <span>
              Если этот ролик от другой квартиры — уберите его с карточки: объект снова будет ждать свой ролик, а правильный объект
              сможет принять этот файл. Посты в сетях это не снимает.
            </span>
          </div>
          <div className="acts">
            <button className="pill ghost sm" type="button" disabled={busy !== null} onClick={() => setAskDiscard(true)}>
              {busy === "discard" ? "Убираем…" : "Удалить с карточки"}
            </button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="mod solve">
          <div className="t">
            <b>Вернуть монтажёру</b>
            <span>Объект уйдёт на перемонтаж с теми же данными карточки. Нужно, когда надпись на самом видео неверная.</span>
          </div>
          <div className="acts">
            <button className="pill sm" type="button" disabled={busy !== null || atEditor} onClick={openSendBack}>
              {busy === "redo" ? "Отправляем…" : "Вернуть монтажёру"}
            </button>
          </div>
          {/* Объект прямо сейчас едет/стоит в очереди к монтажёру (24.09.2026,
              найдено живой проверкой) — «Вернуть монтажёру» про уже ВЫШЕДШИЙ
              ролик, второй раз посылать в этом состоянии нечего, и сервер это
              всё равно откажет. Загрузку готового ролика ниже НЕ гасим: у неё
              свой смысл именно в состоянии «у монтажёра» — так сервер и
              принимает файл, минуя бота (routes/properties/videos.ts ~772). */}
          {atEditor && (
            <p className="state">
              {property.videoHandoffStatus === "QUEUED" ? "Объект в очереди на монтаж." : "Объект уже у монтажёра."}
            </p>
          )}
        </div>
      )}

      {finalUploadBlock}

      {canEdit && publishPlanned && property.scheduledPublishAt && (
        <div className="mod solve">
          <div className="t">
            <b>Публикация запланирована</b>
            <span>
              {published.length === 0
                ? `Ролик принят и разослан по сетям будет ${dushanbeDateTime(property.scheduledPublishAt)}. Площадки — те же, что отмечены выше. `
                : `Новый ролик принят и уйдёт ${dushanbeDateTime(property.scheduledPublishAt)} туда, где объект ещё не вышел. `}
              {/* Причину пишет сама расстановка на сервере
              (lib/publishSchedule.ts): час пик по тепловой карте, отступ от
              предыдущей публикации, закрытое окно. Своего объяснения здесь нет и
              быть не должно — оно разошлось бы с тем, что сервер сделал на самом
              деле, и молча. Пусто причина бывает только у роликов, расставленных
              до 23.09.2026, когда поля ещё не было. */}
              {property.scheduledPublishReason ||
                "Расстановка по времени не даёт нескольким принятым подряд роликам уйти одним залпом."}
            </span>
          </div>
          {/* Право — как у сервера на /publish-now (маркетинг, директор, админ):
              агенту кнопка отвечала бы отказом. */}
          {canPublishNow && (
            <div className="acts">
              <button
                className="pill ghost sm"
                type="button"
                disabled={busy !== null || clipReviewPending}
                title={clipReviewPending ? "Сначала одобрите ролик" : undefined}
                onClick={() =>
                  run(
                    "publishNow",
                    () => api<{ ok: boolean }>(`/properties/${property.id}/publish-now`, { method: "POST" }),
                    () => "Публикация поставлена на ближайший проход — минута-две."
                  )
                }
              >
                {busy === "publishNow" ? "Ставим…" : "Опубликовать сейчас"}
              </button>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="mod solve">
          <div className="t">
            <b>Обновить подписи</b>
            <span>Поправили поля карточки — подпись соберётся заново и уедет в вышедшие посты. Надпись внутри видео так не меняется.</span>
          </div>
          <div className="acts">
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "captions",
                  () => api<CaptionResult>(`/properties/${property.id}/refresh-captions`, { method: "POST" }),
                  (r) => {
                    setManual(r.manual);
                    setManualKind("captions");
                    return r.updated.length > 0
                      ? `Подпись обновлена: ${channelList(r.updated)}.`
                      : "Подпись в карточке пересобрана. В вышедших постах менять было нечего.";
                  }
                )
              }
            >
              {busy === "captions" ? "Обновляем…" : "Обновить подписи"}
            </button>
          </div>
        </div>
      )}

      {canEdit && canStories && storyBlocks}

      {canEdit && canStories && property.videoHandoffFinalPath && (
        <div className="mod solve">
          <div className="t">
            <b>Ролик в истории</b>
            <span>
              Тот же ролик — в истории Instagram (и Facebook, если включено в Настройках), отдельно от ленты. Ролики
              длиннее 60 секунд уйдут несколькими историями подряд.
              {lastStory?.lastPublishedAt ? ` Последний раз: ${dushanbeDateTime(lastStory.lastPublishedAt)}.` : ""}
            </span>
            {lastStory?.lastPublishedAt && lastStory.channel && (
              <span className="quiet" style={{ marginTop: 4 }}>
                <ChannelIcon channel={lastStory.channel} tone="ink" size={13} />
                <span>{lastStory.channel === "FACEBOOK" ? "Facebook" : "Instagram"}</span>
              </span>
            )}
          </div>
          <div className="acts">
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy !== null || clipReviewPending}
              title={clipReviewPending ? "Сначала одобрите ролик" : undefined}
              onClick={() =>
                run(
                  "stories",
                  () =>
                    api<{ ok: boolean; publishedParts: number; totalParts: number; error?: string }>(
                      `/properties/${property.id}/instagram-stories-publish`,
                      { method: "POST" }
                    ),
                  (r) => {
                    if (r.ok) return `Выложено в истории: ${r.publishedParts} из ${r.totalParts} ${r.totalParts === 1 ? "части" : "частей"}.`;
                    if (r.publishedParts > 0) return `Выложена только часть: ${r.publishedParts} из ${r.totalParts}. ${r.error ?? ""}`.trim();
                    throw new Error(r.error ?? "Не удалось выложить в истории");
                  }
                )
              }
            >
              {busy === "stories" ? "Публикуем…" : "Выложить в истории"}
            </button>
          </div>
        </div>
      )}

      {canUnpublish && (
        <div className="mod solve">
          <div className="t">
            <b>Убрать из соцсетей</b>
            <span>
              {published.length > 0
                ? `Сейчас опубликовано: ${channelList(published)}. Снимем там, где это разрешает сама сеть, остальное покажем списком.`
                : "В CRM нет отметок, что ролик где-то вышел, — снимать нечего. Если пост лежит в сети, выложенный вручную, удалите его там сами."}
            </span>
          </div>
          <div className="acts">
            <button
              className="pill ghost sm"
              type="button"
              disabled={busy !== null || published.length === 0}
              onClick={() => {
                setUnpublishPick([...published]);
                setAskUnpublish(true);
              }}
            >
              {busy === "unpublish" ? "Убираем…" : "Убрать из соцсетей"}
            </button>
          </div>
        </div>
      )}

      <div className="mod solve">
        <div className="t">
          <b>Что ушло монтажёру</b>
          <span>Вся переписка бота с монтажёром по этому объекту — не нужно просить у него скриншот.</span>
        </div>
        <div className="acts">
          <button
            className="pill ghost sm"
            type="button"
            aria-expanded={historyOpen}
            aria-controls="montajer-history"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            {historyOpen ? "Скрыть" : "Показать"}
          </button>
        </div>
      </div>

      {historyOpen && (
        <div id="montajer-history">
          {historyLoading && (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">Загружаем…</span>
            </p>
          )}
          {historyErr && (
            <p className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{historyErr instanceof Error ? historyErr.message : "Не удалось загрузить"}</span>
            </p>
          )}
          {!historyLoading && !historyErr && (history?.length ?? 0) === 0 && (
            <p className="quiet">
              <span className="dot" />
              <span className="txt">Пока ничего не отправляли</span>
            </p>
          )}
          {history && history.length > 0 && (
            <div className="list">
              {history.map((m) => (
                <div className="row wrapt" key={m.id}>
                  <div className="t">
                    <b>{dushanbeDateTime(m.sentAt)}</b>
                    {MONTAJER_MESSAGE_KIND[m.kind] ? <span className="chip">{MONTAJER_MESSAGE_KIND[m.kind]}</span> : null}
                    <span className="quote">
                      <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{m.text}</pre>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {history && history.length === MONTAJER_MESSAGES_LIMIT && <p className="state">Показаны последние {MONTAJER_MESSAGES_LIMIT}.</p>}
        </div>
      )}

      {!resultNearUpload && resultBanners}

      {manual.length > 0 && (
        <>
          <h3 className="sec-t">Это придётся сделать руками</h3>
          {manualKind === "removal" && (
            <p className="state">Удалите пост в приложении и нажмите «Удалено» — тогда новый ролик уйдёт и туда.</p>
          )}
          <div className="list">
            {manual.map((step) => (
              <div className="row" key={step.channel}>
                <div className="t">
                  <b>{CHANNEL_NAMES[step.channel]}</b>
                  <span>{step.reason}</span>
                </div>
                {(step.url || manualKind === "removal") && (
                  <div className="act">
                    {step.url && (
                      <a className="pill ghost sm" href={step.url} target="_blank" rel="noreferrer">
                        Открыть пост
                      </a>
                    )}
                    {manualKind === "removal" && (
                      <button
                        className="pill sm"
                        type="button"
                        disabled={byHandBusy !== null}
                        onClick={() => void confirmRemovedByHand(step.channel)}
                      >
                        {byHandBusy === step.channel ? "Отмечаем…" : "Удалено"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {askDiscard && (
        <ConfirmDialog
          title="Удалить принятый ролик с карточки?"
          description="Ролик и ждущая публикация уйдут с этой карточки, объект снова будет ждать свой ролик. Посты, которые уже вышли в сети, останутся — их снимает «Убрать из соцсетей»."
          confirmLabel="Удалить с карточки"
          onCancel={() => setAskDiscard(false)}
          onConfirm={() => {
            setAskDiscard(false);
            void run(
              "discard",
              () => api<{ ok: boolean; publishedChannels: string[] }>(`/properties/${property.id}/final-video/discard`, { method: "POST" }),
              (r) =>
                r.publishedChannels.length > 0
                  ? `Ролик убран с карточки. В ${channelList(r.publishedChannels)} он ещё вышел — снимите через «Убрать из соцсетей».`
                  : "Ролик убран с карточки. Объект снова ждёт свой ролик."
            );
          }}
        />
      )}

      {askUnpublish && (
        <ConfirmDialog
          title="Убрать ролик из соцсетей?"
          description="Отметьте сети, откуда убрать. Удалённый пост вернуть нельзя."
          confirmLabel={`Убрать выбранные (${unpublishPick.length})`}
          confirmDisabled={unpublishPick.length === 0}
          onCancel={() => setAskUnpublish(false)}
          onConfirm={() => {
            setAskUnpublish(false);
            void run(
              "unpublish",
              () =>
                api<RemovalResult>(`/properties/${property.id}/social-unpublish`, {
                  method: "POST",
                  body: unpublishPick.length === published.length ? undefined : { channels: unpublishPick },
                }),
              (r) => {
                setManual(r.manual);
                setManualKind("removal");
                const text = removalParts(r).join(". ");
                return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "Убирать было нечего.";
              }
            );
          }}
        >
          <div className="list" role="group" aria-label="Из каких сетей убрать">
            {PUBLISH_CHANNEL_ORDER.filter((c) => published.includes(c)).map((channel) => {
              const checked = unpublishPick.includes(channel);
              const autoRemovable = channel !== "TIKTOK";
              return (
                <div key={channel} className="row wrapt">
                  <label style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "flex-start", flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setUnpublishPick((prev) => (prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]))
                      }
                    />
                    <span className="t">
                      <b>{CHANNEL_NAMES[channel] ?? channel}</b>
                      <span>
                        {autoRemovable
                          ? channel === "INSTAGRAM"
                            ? "Удалим сами по ссылке на пост. Если Instagram откажет — покажем, как убрать в приложении."
                            : "Удалим сами."
                          : "Программой удалить нельзя — только в приложении. Покажем ссылку, потом нажмёте «Удалено»."}
                      </span>
                    </span>
                  </label>
                  {(channel === "INSTAGRAM" || channel === "TIKTOK") && (
                    <button
                      className="pill ghost sm"
                      type="button"
                      disabled={byHandBusy !== null}
                      onClick={() => {
                        setAskUnpublish(false);
                        void confirmRemovedByHand(channel);
                      }}
                    >
                      {byHandBusy === channel ? "Отмечаем…" : "Уже удалил в приложении"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </ConfirmDialog>
      )}

      {askRedo && (
        <ConfirmDialog
          title="Причина возврата монтажёру"
          description="Монтажёр увидит причину и комментарий вместе с объектом — карточку заполнять заново не нужно."
          confirmLabel={busy === "redo" ? "Отправляем…" : "Отправить монтажёру"}
          danger={false}
          confirmDisabled={busy !== null || sendBackBlocker !== null}
          confirmHint={busy === null ? sendBackBlocker : null}
          // Гонка «закрыли окно, пока грузится исходник» (24.09.2026, п.1):
          // пока идёт загрузка, Esc/подложка/«Закрыть»/«Отмена» выключены все
          // разом — уходить можно только явной кнопкой «Отменить загрузку»
          // рядом с прогрессом ниже.
          dismissible={!sourceUploading}
          onCancel={closeSendBack}
          onConfirm={() => void handleSendBack()}
        >
          <div className="fld wide">
            <span className="lab">
              Что не так <span style={{ color: "var(--crit)" }}>*</span>
            </span>
            <div className="list" role="radiogroup" aria-label="Причина возврата монтажёру">
              {SEND_BACK_REASONS.map((r) => {
                const checked = redoReason === r.value;
                return (
                  <button
                    key={r.value}
                    ref={reasonRoving.register(r.value)}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={reasonRoving.tabIndex(r.value)}
                    className="row wrapt"
                    onClick={() => setRedoReason(r.value)}
                    onKeyDown={(e) => reasonRoving.onKeyDown(e, r.value, setRedoReason)}
                  >
                    <span className={checked ? "dot ok" : "dot"} aria-hidden />
                    <span className="t">
                      <b>{r.label}</b>
                      {r.note && <span>{r.note}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {redoReasonMeta && (
            <label className="fld">
              <span className="lab">
                Комментарий {redoReasonMeta.commentRequired ? <span style={{ color: "var(--crit)" }}>*</span> : "— необязательно"}
              </span>
              <textarea
                autoFocus
                rows={2}
                value={redoComment}
                onChange={(e) => setRedoComment(e.target.value)}
                placeholder={redoReasonMeta.hint ?? "Коротко, что нужно поправить"}
              />
            </label>
          )}

          {published.length > 0 && (
            <div className="fld wide">
              <p className="state">
                <span className="dot warn" />
                Ролик уже вышел в {channelList(published)} — после переделки новый уйдёт только в каналы, где его ещё
                не было.
              </p>
              {canUnpublish && (
                <div className="list" role="group" aria-label="Убрать старый ролик из соцсетей">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={removeFromSocial}
                    className="row wrapt"
                    onClick={() => setRemoveFromSocial((v) => !v)}
                  >
                    <span className={removeFromSocial ? "dot ok" : "dot"} aria-hidden />
                    <span className="t">
                      <b>Сначала убрать старый ролик из соцсетей</b>
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="fld wide">
            <span className="lab">Исходник для монтажа</span>
            <div className="list" role="radiogroup" aria-label="Исходник для монтажа">
              <button
                ref={sourceRoving.register("keep")}
                type="button"
                role="radio"
                aria-checked={sourceMode === "keep"}
                tabIndex={sourceRoving.tabIndex("keep")}
                className="row wrapt"
                disabled={!hasCurrentSource || sourceUploading}
                onClick={() => setSourceMode("keep")}
                onKeyDown={(e) => sourceRoving.onKeyDown(e, "keep", setSourceMode)}
              >
                <span className={sourceMode === "keep" ? "dot ok" : "dot"} aria-hidden />
                <span className="t">
                  <b>Оставить текущий</b>
                  <span>
                    {currentSources.isLoading
                      ? "Проверяем, что лежит на сервере…"
                      : currentSources.isError
                        ? "Не удалось получить список исходников"
                        : hasCurrentSource
                          ? keptSources
                              .map((v) => `${v.filename} · ${formatMb(v.sizeBytes)}${v.hasAudio === false ? " · ⚠ без звука" : ""}`)
                              .join(", ")
                          : "Исходников на сервере нет — их убрали после публикации. Загрузите новый."}
                  </span>
                </span>
              </button>
              <button
                ref={sourceRoving.register("new")}
                type="button"
                role="radio"
                aria-checked={sourceMode === "new"}
                tabIndex={sourceRoving.tabIndex("new")}
                className="row wrapt"
                disabled={sourceUploading}
                onClick={() => setSourceMode("new")}
                onKeyDown={(e) => sourceRoving.onKeyDown(e, "new", setSourceMode)}
              >
                <span className={sourceMode === "new" ? "dot ok" : "dot"} aria-hidden />
                <span className="t">
                  <b>Загрузить новый</b>
                  <span>Старые исходники удалятся, только когда объект уйдёт монтажёру.</span>
                </span>
              </button>
            </div>
            {sourceMode === "new" && (
              <div className="acts" style={{ marginTop: 8 }}>
                <input
                  ref={sourceInput}
                  type="file"
                  accept="video/*"
                  style={{ display: "none" }}
                  onChange={(e) => void pickNewSource(e.target.files?.[0])}
                />
                <button
                  className="pill ghost sm"
                  type="button"
                  disabled={sourceUploading || busy !== null}
                  onClick={() => sourceInput.current?.click()}
                >
                  {newSourceVideoId ? "Выбрать другой файл" : "Выбрать видео"}
                </button>
                {newSource && (
                  <span className="note" aria-live="polite">
                    {newSource.name} · {formatMb(newSource.size)}
                    {sourceUploading ? ` — загружаем ${sourceProgress}%` : newSourceVideoId ? " — загружен" : ""}
                  </span>
                )}
                {sourceUploading && (
                  <button className="pill ghost sm" type="button" onClick={cancelSourceUpload}>
                    Отменить загрузку
                  </button>
                )}
              </div>
            )}
            {sourceMode === "new" && sourceError && (
              <p className="state err">
                <span className="dot crit" />
                {sourceError}
              </p>
            )}
          </div>

          {redoReason && redoCommentReady && (
            <span className="quote">
              <b>Увидит монтажёр</b>
              <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>
                {previewLoading ? "Собираем текст…" : previewError ? previewError : (preview ?? "")}
              </pre>
            </span>
          )}

          {error && busy === null && (
            <p className="state err">
              <span className="dot crit" />
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
      </section>
      {/* Объекту без ролика — и блок фото-поста, как раньше в свёрнутом виде. Закрытый
          объект («только для своих клиентов») в соцсети не выходит ни в каком виде. */}
      {noClip && !property.offSite && <PhotoPostBlock propertyId={property.id} canPublish={canStories} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Фото-посты для объектов без ролика (28.09.2026, agent-brief.md)
// ---------------------------------------------------------------------------

const PHOTO_POST_CHANNEL_ORDER = ["INSTAGRAM", "FACEBOOK", "TELEGRAM"] as const;

interface PhotoPostRecord {
  id: string;
  channel: string;
  status: "SCHEDULED" | "PUBLISHED" | "FAILED" | "REMOVED";
  scheduledAt: string | null;
  publishedAt: string | null;
  permalink: string | null;
  error: string | null;
}

/**
 * Блок «Фото-пост» в карточке объекта без ролика (storiesOnly) — чипы по трём
 * каналам (тот же приём, что «Где вышел ролик» выше: publishedChannelsBlock),
 * кнопка ручной публикации и строка «запланирован», если тик уже выдал слот.
 * СВОЙ маленький кусок состояния — не переиспользует общий `run`/`busy` этого
 * файла (тот заточен под четыре действия видео-конвейера), фото-пост не про
 * видео и от них не зависит.
 */
function PhotoPostBlock({ propertyId, canPublish }: { propertyId: string; canPublish: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["photo-posts", propertyId],
    queryFn: () => api<{ posts: PhotoPostRecord[] }>(`/properties/${propertyId}/photo-posts`).then((r) => r.posts),
    staleTime: 30_000,
  });
  const posts = data ?? [];
  const byChannel = new Map(posts.map((p) => [p.channel, p]));
  const scheduled = posts.find((p) => p.status === "SCHEDULED" && p.scheduledAt);

  async function publishNow() {
    setError(null);
    setBusy(true);
    try {
      await api(`/properties/${propertyId}/photo-post`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["photo-posts", propertyId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Фото-пост</h2>
        <span className="note">Карусель вместо ролика, пока его нет</span>
      </div>

      <div className="mod solve">
        <div className="acts" style={{ flexWrap: "wrap" }}>
          {PHOTO_POST_CHANNEL_ORDER.map((channel) => {
            const record = byChannel.get(channel);
            const label = CHANNEL_NAMES[channel] ?? channel;
            if (record?.status === "PUBLISHED") {
              const content = (
                <>
                  <ChannelIcon channel={channel} tone="ink" size={13} />
                  <span>{label}</span>
                  <Check size={12} aria-hidden />
                </>
              );
              return record.permalink ? (
                <a key={channel} className="chip ok" href={record.permalink} target="_blank" rel="noreferrer" title={`Открыть пост: ${label}`}>
                  {content}
                </a>
              ) : (
                <span key={channel} className="chip ok">
                  {content}
                </span>
              );
            }
            if (record?.status === "FAILED") {
              return (
                <span key={channel} className="chip crit" title={record.error ?? undefined}>
                  <ChannelIcon channel={channel} tone="ink" size={13} />
                  <span>{label}</span>
                  <X size={12} aria-hidden />
                  <span>не ушло</span>
                </span>
              );
            }
            return (
              <span key={channel} className="chip mute">
                <ChannelIcon channel={channel} tone="ink" size={13} />
                <span>{label}</span>
              </span>
            );
          })}
        </div>

        {scheduled?.scheduledAt && (
          <p className="state">Запланирован на {dushanbeDateTime(scheduled.scheduledAt)}.</p>
        )}

        {canPublish && (
          <div className="acts" style={{ marginTop: "var(--s2)" }}>
            <button className="pill sm" type="button" disabled={busy} onClick={publishNow}>
              {busy ? "Публикуем…" : "Опубликовать фото-пост сейчас"}
            </button>
          </div>
        )}

        {error && (
          <p className="state err">
            <span className="dot crit" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Повторные показы (28.09.2026, agent-brief.md reposts-digests)
// ---------------------------------------------------------------------------

interface RepostRecord {
  id: string;
  round: number;
  hook: string;
  channel: string;
  status: "SCHEDULED" | "PUBLISHED" | "FAILED" | "REMOVED";
  scheduledAt: string | null;
  publishedAt: string | null;
  permalink: string | null;
  error: string | null;
}

/**
 * Блок «Повторные показы» (28.09.2026, agent-brief.md reposts-digests) —
 * задание §3 просит его «рядом с PhotoPostBlock», но кандидаты повтора
 * (lib/socialReposts.ts::scheduleRepostsTick) — ЛЮБОЙ AVAILABLE объект, не
 * только storiesOnly (без ролика), где PhotoPostBlock единственно и
 * монтируется. Решение по умолчанию: смонтирован ОТДЕЛЬНО, как
 * FacebookGroupShareBlock рядом (не внутри PropertyVideoFixCard) — тем же
 * местом в PropertyDetail.tsx, тем же гейтом `status === "AVAILABLE"`, чтобы
 * повтор был виден на любой карточке в продаже, а не только у объектов без
 * видео.
 *
 * Строка «Повторный показ №N: дата (крючок)» на САМЫЙ СВЕЖИЙ круг + чипы по
 * каналам этого круга (тот же приём, что у PhotoPostBlock) + кнопка «Показать
 * ещё раз сейчас».
 */
export function RepostBlock({ property, readOnly, canEdit }: { property: Property; readOnly?: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.agent?.role);
  const canPublish = !readOnly && (role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN");
  const enabled = !readOnly && !property.offSite && property.status === "AVAILABLE";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const propertyId = property.id;

  const { data } = useQuery({
    queryKey: ["reposts", propertyId],
    queryFn: () => api<{ reposts: RepostRecord[] }>(`/properties/${propertyId}/reposts`).then((r) => r.reposts),
    enabled,
    staleTime: 30_000,
  });
  const reposts = data ?? [];
  // Пустой блок «Повторов пока не было» агенту ничего не даёт: запускать повтор может только маркетинг.
  if (!enabled || (reposts.length === 0 && !canPublish)) return null;

  const latestRound = reposts.reduce((max, r) => Math.max(max, r.round), 0);
  const currentRoundRows = reposts.filter((r) => r.round === latestRound);
  const byChannel = new Map(currentRoundRows.map((r) => [r.channel, r]));
  const hook = currentRoundRows[0]?.hook;
  const roundDate = currentRoundRows.find((r) => r.publishedAt)?.publishedAt ?? currentRoundRows.find((r) => r.scheduledAt)?.scheduledAt ?? null;

  async function repostNow() {
    setError(null);
    setBusy(true);
    try {
      await api(`/properties/${propertyId}/repost`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: ["reposts", propertyId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Повторные показы</h2>
        <span className="note">Тот же объект, новый текст, через время</span>
      </div>

      <div className="mod solve">
        {latestRound > 0 && (
          <p className="state">
            Повторный показ №{latestRound}
            {roundDate ? `: ${dushanbeDateTime(roundDate)}` : ""}
            {hook ? ` (${hook})` : ""}
          </p>
        )}

        {latestRound > 0 && (
          <div className="acts" style={{ flexWrap: "wrap" }}>
            {PHOTO_POST_CHANNEL_ORDER.map((channel) => {
              const record = byChannel.get(channel);
              const label = CHANNEL_NAMES[channel] ?? channel;
              if (record?.status === "PUBLISHED") {
                const content = (
                  <>
                    <ChannelIcon channel={channel} tone="ink" size={13} />
                    <span>{label}</span>
                    <Check size={12} aria-hidden />
                  </>
                );
                return record.permalink ? (
                  <a key={channel} className="chip ok" href={record.permalink} target="_blank" rel="noreferrer" title={`Открыть пост: ${label}`}>
                    {content}
                  </a>
                ) : (
                  <span key={channel} className="chip ok">
                    {content}
                  </span>
                );
              }
              if (record?.status === "FAILED") {
                return (
                  <span key={channel} className="chip crit" title={record.error ?? undefined}>
                    <ChannelIcon channel={channel} tone="ink" size={13} />
                    <span>{label}</span>
                    <X size={12} aria-hidden />
                    <span>не ушло</span>
                  </span>
                );
              }
              return (
                <span key={channel} className="chip mute">
                  <ChannelIcon channel={channel} tone="ink" size={13} />
                  <span>{label}</span>
                </span>
              );
            })}
          </div>
        )}

        {latestRound === 0 && <p className="state">Повторов пока не было.</p>}

        {canPublish && (
          <div className="acts" style={{ marginTop: "var(--s2)" }}>
            <button className="pill sm" type="button" disabled={busy} onClick={repostNow}>
              {busy ? "Публикуем…" : "Показать ещё раз сейчас"}
            </button>
          </div>
        )}

        {error && (
          <p className="state err">
            <span className="dot crit" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

interface SocialExtrasCounts {
  photoPosts: number;
  reposts: number;
  stories: number;
}

interface SocialExtrasRemoval {
  photoPosts: { removed: string[]; failed: { error: string }[]; manual: { reason: string }[] };
  reposts: { removed: number; failed: { error: string }[]; manual: { reason: string }[] };
  stories: { removed: number; failed: { error: string }[]; manual: { reason: string }[] };
}

/**
 * «СНЯТЬ КАРУСЕЛИ И ИСТОРИИ» (владелец, 02.10.2026: «чтобы мы сами снимали
 * истории и карусели»). Ролик не трогает — его снимает панель «Убрать из
 * соцсетей» выше. Кнопка видна маркетингу/директору/админу и только когда есть
 * что снимать (сервер считает карусели, повторные показы и живые истории);
 * удаление видно подписчикам и необратимо, поэтому через ConfirmDialog.
 */
export function SocialExtrasBlock({ property, readOnly }: { property: Property; readOnly?: boolean }) {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.agent?.role);
  const canRemove = !readOnly && (role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN");
  const propertyId = property.id;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["social-extras", propertyId],
    queryFn: () => api<SocialExtrasCounts>(`/properties/${propertyId}/social-extras`),
    enabled: canRemove,
    staleTime: 15_000,
  });
  if (!canRemove) return null;
  const counts = data ?? { photoPosts: 0, reposts: 0, stories: 0 };
  const carousels = counts.photoPosts + counts.reposts;
  if (carousels + counts.stories === 0 && !report && !error) return null;

  async function remove() {
    setConfirming(false);
    setError(null);
    setReport(null);
    setBusy(true);
    try {
      const r = await api<SocialExtrasRemoval>(`/properties/${propertyId}/social-extras/remove`, { method: "POST" });
      const removed = r.photoPosts.removed.length + r.reposts.removed + r.stories.removed;
      const failed = [...r.photoPosts.failed, ...r.reposts.failed, ...r.stories.failed];
      const manual = [...r.photoPosts.manual, ...r.reposts.manual, ...r.stories.manual];
      const parts = [`Снято: ${removed}.`];
      if (failed.length > 0) parts.push(`Не удалось: ${failed.length} (${failed[0].error}).`);
      if (manual.length > 0) parts.push(`Снимите вручную: ${manual.length} (${manual[0].reason}).`);
      setReport(parts.join(" "));
      await qc.invalidateQueries({ queryKey: ["social-extras", propertyId] });
      await qc.invalidateQueries({ queryKey: ["photo-posts", propertyId] });
      await qc.invalidateQueries({ queryKey: ["reposts", propertyId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  }

  const summary = [carousels > 0 ? `карусели: ${carousels}` : null, counts.stories > 0 ? `истории: ${counts.stories}` : null]
    .filter(Boolean)
    .join(", ");

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Карусели и истории</h2>
        <span className="note">Не трогает ролик</span>
      </div>
      <div className="mod solve">
        {summary && <p className="state">Сейчас в соцсетях — {summary}.</p>}
        {summary && (
          <div className="acts" style={{ marginTop: "var(--s2)" }}>
            <button className="pill sm" type="button" disabled={busy} onClick={() => setConfirming(true)}>
              {busy ? "Снимаем…" : "Снять карусели и истории"}
            </button>
          </div>
        )}
        {report && <p className="state">{report}</p>}
        {error && (
          <p className="state err">
            <span className="dot crit" />
            {error}
          </p>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Снять карусели и истории?"
          description={`Будет удалено из Instagram, Facebook и Telegram: ${summary}. Ролик останется. Вернуть удалённое нельзя.`}
          confirmLabel="Снять"
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

/** Одна группа из GET .../group-share — см. lib/facebookGroupShare.ts::GroupShareItem на сервере. */
type GroupShareItem = { name: string; url: string; sharedAt: string | null; agentName: string | null; text: string };
type GroupShareStatus = { groups: GroupShareItem[]; done: number; total: number };

/**
 * «РАЗДАТЬ ПО ГРУППАМ FACEBOOK» (28.09.2026, docs/agent-briefs/facebook-groups-share-28-09.md).
 * Отдельный компонент, а не ветка внутри PropertyVideoFixCard: гейт здесь свой
 * («объект в продаже», а не «есть что чинить с роликом») и не должен зависеть
 * от ранних `return null` того компонента (readOnly уже учтён своим пропом,
 * `storiesOnly`/«ролика нет» — не должны прятать раздачу по группам вовсе).
 * Монтируется в PropertyDetail.tsx рядом с PropertyVideoFixCard — на телефоне и
 * на компьютере одинаково (там же, где PropertyCoverStatus).
 *
 * Групп в Настройках нет (`total === 0`) или объект не в продаже — компонент
 * молча ничего не рисует, панель не должна быть шумом там, где раздавать
 * нечего.
 *
 * Публиковать в группу может только человек (Groups API у Meta закрыт
 * 22.04.2024, автоматизация нажатия = бан) — кнопка копирует текст в буфer и
 * открывает группу; «Выложено»/«Отменить» доступны хозяину объекта или
 * маркетингу (сервер решает окончательно, `canEdit` здесь — тот же расчёт
 * ответственности, что и у всей карточки, только чтобы не рисовать кнопки
 * тому, кому сервер их всё равно не разрешит).
 */
export function FacebookGroupShareBlock({
  property,
  readOnly,
  canEdit,
}: {
  property: Property;
  readOnly?: boolean;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyModalText, setCopyModalText] = useState<string | null>(null);

  const enabled = !readOnly && !property.offSite && property.status === "AVAILABLE";
  const queryKey = ["property-group-share", property.id];
  const { data } = useQuery({
    queryKey,
    queryFn: () => api<GroupShareStatus>(`/properties/${property.id}/group-share`),
    enabled,
    staleTime: 30_000,
  });

  async function copyAndOpen(text: string, url: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Буфер недоступен (нет разрешения, небезопасный контекст) — показываем
      // текст в окне, чтобы скопировать вручную, но группу всё равно открываем:
      // человеку и так придётся вставлять текст самому.
      setCopyModalText(text);
    }
    window.open(url, "_blank", "noopener");
  }

  async function toggleDone(index: number, currentlyDone: boolean) {
    setBusyIndex(index);
    setError(null);
    try {
      await api(`/properties/${property.id}/group-share/${index}/done`, { method: currentlyDone ? "DELETE" : "POST" });
      await qc.invalidateQueries({ queryKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось, попробуйте ещё раз");
    } finally {
      setBusyIndex(null);
    }
  }

  if (!enabled || !data || data.total === 0) return null;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Раздать по группам Facebook</h2>
        <span className="note">
          выложено {data.done} из {data.total}
        </span>
      </div>
      <div className="list">
        {data.groups.map((g, i) => (
          <div className="row wrapt" key={g.url}>
            <div className="t">
              <b>{g.name}</b>
              {g.sharedAt ? (
                <span className="chip">
                  Выложено {dushanbeDateTime(g.sharedAt)}
                  {g.agentName ? ` · ${g.agentName}` : ""}
                </span>
              ) : (
                <span>Ещё не выкладывали</span>
              )}
            </div>
            <div className="act">
              <button className="pill ghost sm" type="button" onClick={() => void copyAndOpen(g.text, g.url)}>
                Скопировать текст и открыть
              </button>
              {canEdit && (
                <button
                  className="pill sm"
                  type="button"
                  disabled={busyIndex === i}
                  onClick={() => void toggleDone(i, !!g.sharedAt)}
                >
                  {busyIndex === i ? "…" : g.sharedAt ? "Отменить" : "Выложено"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {error}
        </p>
      )}
      {copyModalText && (
        <Rh2Sheet
          open
          onClose={() => setCopyModalText(null)}
          title="Текст для группы"
          footer={
            <button
              type="button"
              className="pill"
              onClick={() => {
                void navigator.clipboard.writeText(copyModalText).catch(() => {});
                setCopyModalText(null);
              }}
            >
              Скопировать
            </button>
          }
        >
          <p className="state">Буфер обмена недоступен — скопируйте текст вручную, группа уже открылась в новой вкладке.</p>
          <div className="quote">
            <pre style={{ whiteSpace: "pre-wrap", font: "inherit", margin: 0 }}>{copyModalText}</pre>
          </div>
        </Rh2Sheet>
      )}
    </section>
  );
}

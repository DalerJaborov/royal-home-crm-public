import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Copy, ExternalLink, EyeOff, Pencil, Plus, RefreshCw, Rocket, Trash2, Undo2 } from "lucide-react";
import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_COVER_MODE_LABELS,
  destinationKeyOf,
  evaluateVideoForChannels,
  formatBytesRu,
  formatDurationRu,
  parseDestinationKey,
  type ChannelRuntimeLimits,
  type SocialVideoChannel,
  type SocialVideoDestination,
  type SocialVideoRemovalOutcome,
} from "@royal-home/shared";
import {
  useAddSocialVideoDestinations,
  useCopySocialVideo,
  useDeleteSocialVideo,
  useMarkSocialVideoRemoved,
  useRemoveSocialVideo,
  useRetrySocialVideo,
  useSocialVideo,
  useSocialVideoChannels,
  useSocialVideoChannelsLive,
  useUnscheduleSocialVideo,
} from "../../hooks/useSocialVideos";
import { exactDateTime, pluralizeRu } from "../../lib/format";
import {
  INTERRUPTED_RETRY_WARNING,
  RETRYABLE_STATES,
  destinationBlockReasons,
  destinationLabel,
  destinationsInState,
  destinationsOfItem,
  isInterruptedResult,
  resultOfDestination,
} from "../../lib/socialVideoDestinations";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Rh2ErrorState } from "../../components/rh2/Rh2ErrorState";
import { VideoPlayerWithFallback } from "../../components/VideoPlayerWithFallback";
import { ChannelProcess } from "../../components/socialVideos/ChannelProcess";
import { SocialVideoMetadata } from "../../components/socialVideos/SocialVideoMetadata";
import { ChannelPicker } from "../../components/socialVideos/ChannelPicker";
import { ChannelBadge } from "../../components/socialVideos/ChannelBadge";
import {
  SOCIAL_VIDEO_STATUS_CHIP,
  canPublishAgain,
  canRemoveFromSocials,
  errorText,
  factsFromItem,
  isEditable,
  liveByChannel,
  mediaSrc,
} from "./helpers";

/** Склейка итогов снятия: повтор по упавшим адресам заменяет их прежние строки, а не дописывается рядом. */
function mergeOutcome(prev: SocialVideoRemovalOutcome | null, next: SocialVideoRemovalOutcome, asked: string[]): SocialVideoRemovalOutcome {
  if (!prev) return next;
  const wasAsked = (key: string) => asked.includes(key);
  return {
    removed: [...prev.removed, ...next.removed],
    failed: [...prev.failed.filter((f) => !wasAsked(f.key)), ...next.failed],
    manual: [...prev.manual.filter((m) => !wasAsked(m.key)), ...next.manual],
  };
}

/**
 * КАРТОЧКА РОЛИКА — «процесс»: статус, плеер и вертикальная лента по каналам
 * (ждёт → публикуется → вышло со ссылкой / ошибка с текстом площадки).
 * Пока статус PUBLISHING, ролик опрашивается раз в 3 с (hooks/useSocialVideos).
 * Все действия — видимыми кнопками, без скрытых меню.
 *
 * Строки ленты — АДРЕСА «канал + аккаунт». Вышедшему ролику можно добавить сеть или
 * аккаунт (публикация идёт только в новые адреса) и сделать копию черновиком.
 * Повтор адреса, прерванного перезапуском сервера, требует подтверждения: пост мог
 * уже выйти, повтор даст дубль.
 */
export function VideoDetail({
  id,
  onBack,
  onEdit,
}: {
  id: string;
  onBack: () => void;
  /** Открыть композитор на этом ролике. */
  onEdit: (id: string) => void;
}) {
  const query = useSocialVideo(id);
  const retry = useRetrySocialVideo();
  const unschedule = useUnscheduleSocialVideo();
  const remove = useDeleteSocialVideo();
  const addDestinations = useAddSocialVideoDestinations();
  const copy = useCopySocialVideo();
  const removeFromSocials = useRemoveSocialVideo();
  const markRemoved = useMarkSocialVideoRemoved();
  const infos = useSocialVideoChannels().data ?? [];
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Ключи адресов, повтор которых ждёт подтверждения (прерванная публикация). */
  const [confirmRetryKeys, setConfirmRetryKeys] = useState<string[] | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newDestinations, setNewDestinations] = useState<SocialVideoDestination[]>([]);
  const [confirmAdd, setConfirmAdd] = useState(false);
  /** Окно «Снять из соцсетей»: null — закрыто, иначе выбранные ключи адресов. */
  const [removeKeys, setRemoveKeys] = useState<string[] | null>(null);
  /** Итог снятия держим на экране, пока человек сам не закроет. */
  const [outcome, setOutcome] = useState<SocialVideoRemovalOutcome | null>(null);
  const liveQuery = useSocialVideoChannelsLive(addOpen);
  const live = useMemo(() => liveByChannel(liveQuery.data), [liveQuery.data]);

  const item = query.data;

  // Пригодность ролика новым адресам — тем же правилом, что в композиторе; нужна, только пока открыт выбор.
  const addVerdicts = useMemo(() => {
    if (!item || !addOpen) return [];
    const runtime: Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> = {};
    for (const c of SOCIAL_VIDEO_CHANNELS) {
      const r = live[c]?.runtime;
      if (r) runtime[c] = r;
    }
    return evaluateVideoForChannels(SOCIAL_VIDEO_CHANNELS, factsFromItem(item), item.caption, runtime);
  }, [item, addOpen, live]);

  if (query.isLoading) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="state">
            <span className="sk av" />
            <span className="sk w40" />
            <span className="sk w22" /> Загружаем ролик
          </div>
        </div>
      </div>
    );
  }
  if (!item) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <button className="pill ghost sm" type="button" onClick={onBack}>
            <ArrowLeft className="i" aria-hidden />К списку роликов
          </button>
          <Rh2ErrorState
            message={query.error ? errorText(query.error, "Не удалось загрузить ролик.") : "Ролик не найден."}
            onRetry={() => void query.refetch()}
          />
        </div>
      </div>
    );
  }

  const src = mediaSrc(item.videoPath);
  const destinations = destinationsOfItem(item);
  const retryable = destinationsInState(item, RETRYABLE_STATES);
  const hasSkipped = destinationsInState(item, ["SKIPPED"]).length > 0;
  const busy =
    retry.isPending ||
    unschedule.isPending ||
    remove.isPending ||
    addDestinations.isPending ||
    copy.isPending ||
    removeFromSocials.isPending ||
    markRemoved.isPending;
  const publishing = item.status === "PUBLISHING";
  const canAddDestinations = item.status === "DONE" || item.status === "PARTIAL" || item.status === "FAILED";
  const publishedDestinations = destinationsInState(item, ["PUBLISHED"]);
  const canRemove = canRemoveFromSocials(item) && !publishing;
  const takenKeys = new Set(destinations.map(destinationKeyOf));
  const addBlockReasons = destinationBlockReasons(newDestinations, infos, addVerdicts);

  const run = (action: () => Promise<unknown>, fallback: string, then?: () => void) => {
    setActionError(null);
    action().then(
      () => then?.(),
      (err: unknown) => setActionError(errorText(err, fallback))
    );
  };

  /** Снять посты по ключам адресов; итог складываем в `outcome` и держим до закрытия. */
  const doRemove = (keys: string[]) => {
    setActionError(null);
    removeFromSocials.mutateAsync({ id: item.id, keys }).then(
      (res) => setOutcome((prev) => mergeOutcome(prev, res.outcome, keys)),
      (err: unknown) => setActionError(errorText(err, "Не удалось снять посты из соцсетей"))
    );
  };

  /** «Я убрал(а) вручную»: адрес переезжает из «вручную» в «снято». */
  const doMarkRemoved = (key: string, label: string) => {
    setActionError(null);
    markRemoved.mutateAsync({ id: item.id, keys: [key] }).then(
      () =>
        setOutcome((prev) =>
          prev
            ? {
                ...prev,
                manual: prev.manual.filter((m) => m.key !== key),
                removed: [...prev.removed, { key, label, note: "Отмечено вручную" }],
              }
            : prev
        ),
      (err: unknown) => setActionError(errorText(err, "Не удалось отметить пост снятым"))
    );
  };

  const doRetry = (keys: string[]) => run(() => retry.mutateAsync({ id: item.id, keys }), "Не удалось повторить публикацию");

  // Адрес, оборванный перезапуском, мог уже выйти на площадке: без явного «да» не повторяем.
  const requestRetry = (list: SocialVideoDestination[]) => {
    const keys = list.map(destinationKeyOf);
    if (list.some((d) => isInterruptedResult(resultOfDestination(item.results, d)))) setConfirmRetryKeys(keys);
    else doRetry(keys);
  };

  const makeCopy = () => {
    setActionError(null);
    copy.mutateAsync(item.id).then(
      (created) => onEdit(created.id),
      (err: unknown) => setActionError(errorText(err, "Не удалось сделать копию"))
    );
  };

  const closeAdd = () => {
    setAddOpen(false);
    setNewDestinations([]);
    setConfirmAdd(false);
  };

  // Запланированный ролик сервер даёт править только как черновик: сначала снимаем расписание.
  const edit = () => {
    if (item.status === "SCHEDULED") {
      run(() => unschedule.mutateAsync(item.id), "Не удалось вернуть ролик в черновик", () => onEdit(item.id));
    } else {
      onEdit(item.id);
    }
  };

  const facts = [
    item.durationSec !== null ? formatDurationRu(item.durationSec) : null,
    formatBytesRu(item.sizeBytes),
    item.width !== null && item.height !== null ? `${item.width}×${item.height}` : null,
    item.videoCodec ? item.videoCodec.toUpperCase() : null,
    item.hasAudio === false ? "без звука" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <button className="pill ghost sm" type="button" onClick={onBack}>
              <ArrowLeft className="i" aria-hidden />К списку роликов
            </button>
            <h1 style={{ marginTop: 12 }}>{item.title}</h1>
            <SocialVideoMetadata item={item} statusClassName={SOCIAL_VIDEO_STATUS_CHIP[item.status]} />
          </div>
          <div className="acts" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {retryable.length > 0 && !publishing && canPublishAgain(item.status) && (
              <button className="pill" type="button" disabled={busy} onClick={() => requestRetry(retryable)}>
                <RefreshCw className="i" aria-hidden />
                {retry.isPending ? "Повторяем…" : hasSkipped ? "Повторить упавшие и пропущенные" : "Повторить упавшие"}
              </button>
            )}
            {canAddDestinations && !publishing && (
              <button
                className="pill ghost"
                type="button"
                disabled={busy}
                aria-expanded={addOpen}
                onClick={() => (addOpen ? closeAdd() : setAddOpen(true))}
              >
                <Plus className="i" aria-hidden />
                Добавить сеть или аккаунт
              </button>
            )}
            {canRemove && (
              <button
                className="pill ghost"
                type="button"
                disabled={busy}
                onClick={() => setRemoveKeys(publishedDestinations.map(destinationKeyOf))}
              >
                <EyeOff className="i" aria-hidden />
                {removeFromSocials.isPending ? "Снимаем…" : "Снять из соцсетей"}
              </button>
            )}
            {!publishing && (
              <button className="pill ghost" type="button" disabled={busy} onClick={makeCopy}>
                <Copy className="i" aria-hidden />
                {copy.isPending ? "Копируем…" : "Копия черновиком"}
              </button>
            )}
            {item.status === "SCHEDULED" && (
              <button
                className="pill ghost"
                type="button"
                disabled={busy}
                onClick={() => run(() => unschedule.mutateAsync(item.id), "Не удалось вернуть ролик в черновик")}
              >
                <Undo2 className="i" aria-hidden />
                Вернуть в черновик
              </button>
            )}
            {isEditable(item.status) && (
              <button className="pill ghost" type="button" disabled={busy} onClick={edit}>
                <Pencil className="i" aria-hidden />
                Редактировать
              </button>
            )}
            {!publishing && (
              <button className="pill ghost" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="i" aria-hidden />
                Удалить
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">{actionError}</span>
            <button className="lnk" type="button" onClick={() => setActionError(null)}>
              Понятно
            </button>
          </div>
        )}

        {outcome && (
          <section className="card" aria-label="Итог снятия из соцсетей">
            <div className="sec-h stack">
              <h2>Итог снятия из соцсетей</h2>
              <button className="pill ghost sm" type="button" onClick={() => setOutcome(null)}>
                Закрыть итог
              </button>
            </div>
            <div className="list">
              {outcome.removed.map((r) => (
                <OutcomeRow key={`ok-${r.key}`} addressKey={r.key} label={r.label}>
                  <span className="chip ok">Снято</span>
                  {r.note && <span className="note">{r.note}</span>}
                </OutcomeRow>
              ))}
              {outcome.failed.map((f) => (
                <OutcomeRow key={`fail-${f.key}`} addressKey={f.key} label={f.label}>
                  <span className="chip crit">Не вышло</span>
                  <span className="note" role="alert">
                    {f.error}
                  </span>
                  <button className="pill sm" type="button" disabled={busy} onClick={() => doRemove([f.key])}>
                    <RefreshCw className="i" aria-hidden />
                    Повторить снятие
                  </button>
                </OutcomeRow>
              ))}
              {outcome.manual.map((m) => (
                <OutcomeRow key={`man-${m.key}`} addressKey={m.key} label={m.label}>
                  <span className="chip warn">Убрать вручную</span>
                  <span className="note">{m.reason}</span>
                  {m.url && (
                    <a className="pill ghost sm" href={m.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="i" aria-hidden />
                      Открыть пост
                    </a>
                  )}
                  <button className="pill ghost sm" type="button" disabled={busy} onClick={() => doMarkRemoved(m.key, m.label)}>
                    Я убрал(а) вручную
                  </button>
                </OutcomeRow>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="card">
              <div className="sec-h stack">
                <h2>Как идёт публикация</h2>
                {publishing && <span className="note">обновляется каждые 3 секунды</span>}
              </div>
              {destinations.length === 0 ? (
                <div className="empty">
                  <p>Каналы не выбраны — откройте ролик в редакторе и отметьте, куда публиковать.</p>
                </div>
              ) : (
                <ChannelProcess
                  destinations={destinations}
                  infos={infos}
                  results={item.results}
                  onRetryDestination={retryable.length > 0 && !publishing && canPublishAgain(item.status) ? (d) => requestRetry([d]) : undefined}
                />
              )}
            </section>

            {addOpen && canAddDestinations && !publishing && (
              <section className="card" aria-label="Добавить сеть или аккаунт">
                <div className="sec-h stack">
                  <h2>Добавить сеть или аккаунт</h2>
                  <span className="note">публикация запустится только в новые адреса</span>
                </div>
                <ChannelPicker
                  infos={infos}
                  live={live}
                  liveLoading={liveQuery.isLoading}
                  verdicts={addVerdicts}
                  selected={newDestinations}
                  onChange={setNewDestinations}
                  disabled={addDestinations.isPending}
                  lockedKeys={takenKeys}
                />
                {newDestinations.length > 0 && addBlockReasons.length > 0 && (
                  <div className="quiet crit" role="status" style={{ marginTop: 12 }}>
                    <span className="dot crit" />
                    <span className="txt">
                      Пока нельзя добавить:
                      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                        {addBlockReasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    </span>
                  </div>
                )}
                <div className="acts" style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    className="pill"
                    type="button"
                    disabled={busy || newDestinations.length === 0 || addBlockReasons.length > 0}
                    onClick={() => setConfirmAdd(true)}
                  >
                    <Rocket className="i" aria-hidden />
                    {addDestinations.isPending ? "Отправляем…" : "Опубликовать в новые"}
                  </button>
                  <button className="pill ghost" type="button" disabled={addDestinations.isPending} onClick={closeAdd}>
                    Отмена
                  </button>
                </div>
              </section>
            )}
          </div>

          <section className="card">
            <div className="sec-h stack">
              <h2>Ролик</h2>
              <span className="note">{facts}</span>
            </div>
            <VideoPlayerWithFallback
              src={src}
              onDownload={() => window.open(src, "_blank", "noopener")}
              style={{ width: "100%", maxHeight: 460, borderRadius: "var(--r-md)", background: "var(--track)" }}
            />
            {item.coverUrl && (
              <div style={{ marginTop: 12 }}>
                <div className="sec-t">Обложка · {SOCIAL_VIDEO_COVER_MODE_LABELS[item.coverMode]}</div>
                <img
                  src={mediaSrc(item.coverUrl)}
                  alt="Обложка ролика"
                  style={{ width: 120, aspectRatio: "9 / 16", objectFit: "cover", borderRadius: "var(--r-md)" }}
                />
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <div className="sec-t">Подпись</div>
              {item.caption.trim() ? (
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{item.caption}</p>
              ) : (
                <p className="state" style={{ paddingTop: 0 }}>
                  Подписи нет.
                </p>
              )}
            </div>
            {item.brief && (
              <div style={{ marginTop: 12 }}>
                <div className="sec-t">О чём ролик</div>
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{item.brief}</p>
              </div>
            )}
          </section>
        </div>
      </div>

      {confirmRetryKeys && (
        <ConfirmDialog
          title="Повторить публикацию?"
          description={INTERRUPTED_RETRY_WARNING}
          confirmLabel="Всё равно повторить"
          cancelLabel="Сначала проверю"
          onCancel={() => setConfirmRetryKeys(null)}
          onConfirm={() => {
            const keys = confirmRetryKeys;
            setConfirmRetryKeys(null);
            doRetry(keys);
          }}
        />
      )}

      {confirmAdd && (
        <ConfirmDialog
          danger={false}
          title="Опубликовать в новые адреса?"
          description={`Ролик «${item.title}» уйдёт ещё по ${newDestinations.length} ${pluralizeRu(newDestinations.length, ["адресу", "адресам", "адресам"])}. Уже вышедшие посты не затрагиваются.`}
          confirmLabel="Опубликовать"
          onCancel={() => setConfirmAdd(false)}
          onConfirm={() => {
            setConfirmAdd(false);
            run(
              () => addDestinations.mutateAsync({ id: item.id, destinations: newDestinations }),
              "Не удалось добавить адреса",
              closeAdd
            );
          }}
        >
          <div className="list">
            {newDestinations.map((d) => (
              <div className="row" key={destinationKeyOf(d)}>
                <ChannelBadge channel={d.channel} size={28} label={destinationLabel(d, infos)} />
                <div className="t">
                  <b>{destinationLabel(d, infos)}</b>
                </div>
              </div>
            ))}
          </div>
        </ConfirmDialog>
      )}

      {removeKeys && (
        <ConfirmDialog
          title="Снять ролик из соцсетей?"
          description="Пост пропадёт из выбранных соцсетей. Это нельзя отменить."
          confirmLabel="Снять из соцсетей"
          confirmDisabled={removeKeys.length === 0}
          confirmHint={removeKeys.length === 0 ? "Отметьте хотя бы один адрес" : undefined}
          onCancel={() => setRemoveKeys(null)}
          onConfirm={() => {
            const keys = removeKeys;
            setRemoveKeys(null);
            doRemove(keys);
          }}
        >
          <div className="list">
            {publishedDestinations.map((d) => {
              const key = destinationKeyOf(d);
              const checked = removeKeys.includes(key);
              const label = destinationLabel(d, infos);
              return (
                <label className="row" key={key} style={{ cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setRemoveKeys(checked ? removeKeys.filter((k) => k !== key) : [...removeKeys, key])}
                    style={{ width: 20, height: 20, flex: "none" }}
                  />
                  <ChannelBadge channel={d.channel} size={28} label={label} />
                  <div className="t">
                    <b>{label}</b>
                  </div>
                </label>
              );
            })}
          </div>
        </ConfirmDialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Удалить ролик?"
          description={
            item.status === "DONE" || item.status === "PARTIAL"
              ? "Ролик исчезнет из CRM, но уже опубликованные посты в соцсетях останутся — убрать их можно только в самих сетях."
              : "Ролик и его обложка удалятся из CRM без возможности восстановить."
          }
          confirmLabel="Удалить"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            run(() => remove.mutateAsync(item.id), "Не удалось удалить ролик", onBack);
          }}
        />
      )}
    </div>
  );
}

/** Строка итога снятия: значок сети, подпись адреса и то, что с ним случилось (чип, пояснение, кнопки). */
function OutcomeRow({ addressKey, label, children }: { addressKey: string; label: string; children: ReactNode }) {
  const channel = parseDestinationKey(addressKey)?.channel;
  return (
    <div className="row wrapt">
      {channel && <ChannelBadge channel={channel} size={28} label={label} />}
      <div className="t">
        <b>{label}</b>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 4 }}>{children}</span>
      </div>
    </div>
  );
}

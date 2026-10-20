import { toast } from "../../store/toast";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CalendarClock, Image as ImageIcon, Share2, Film, PenLine, RefreshCw } from "lucide-react";
import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES,
  SOCIAL_VIDEO_STATUS_LABELS,
  destinationKeyOf,
  evaluateVideoForChannels,
  type ChannelRuntimeLimits,
  type SocialVideoCaptionLanguage,
  type SocialVideoCaptionTone,
  type SocialVideoChannel,
  type SocialVideoDestination,
  type SocialVideoDuplicate,
  type SocialVideoFacts,
} from "@royal-home/shared";
import { pluralizeRu, exactDateTime } from "../../lib/format";
import {
  channelsOfDestinations,
  destinationBlockReasons,
  destinationLabel,
  destinationsOfItem,
  sameDestinations,
} from "../../lib/socialVideoDestinations";
import {
  useClearSocialVideoCover,
  useCreateSocialVideo,
  useDeleteSocialVideo,
  useGenerateSocialVideoCaption,
  useGenerateSocialVideoCover,
  usePublishSocialVideo,
  useRefreshSocialVideoChannelsLive,
  useSocialVideo,
  useSocialVideoChannels,
  useSocialVideoChannelsLive,
  useUpdateSocialVideo,
  useUploadSocialVideoCover,
} from "../../hooks/useSocialVideos";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { VideoDropzone } from "../../components/socialVideos/VideoDropzone";
import { VerdictChips } from "../../components/socialVideos/VerdictChips";
import { CaptionStudio } from "../../components/socialVideos/CaptionStudio";
import { CoverPicker, type CoverAiOptions } from "../../components/socialVideos/CoverPicker";
import { ChannelPicker } from "../../components/socialVideos/ChannelPicker";
import { SchedulePicker } from "../../components/socialVideos/SchedulePicker";
import { ChannelBadge } from "../../components/socialVideos/ChannelBadge";
import { ComposerSummary } from "./ComposerSummary";
import {
  earliestScheduleMs,
  errorText,
  factsFromItem,
  liveByChannel,
  mediaSrc,
  mergeFacts,
  titleFromFileName,
} from "./helpers";

/**
 * КОМПОЗИТОР РОЛИКА (12.10.2026): ролик → текст → обложка → каналы → время, а
 * справа липкая сводка «как уйдёт».
 *
 * Состояние держим здесь, дочерние компоненты управляемые и без своих запросов.
 *  - Черновик на сервере создаётся при первой загрузке файла (POST /social-videos).
 *  - Куда публиковать — список АДРЕСОВ «канал + аккаунт» (`destinations`); каналы выводятся из них.
 *    Выбор канала без явных аккаунтов = аккаунт по умолчанию (`accountId: null`).
 *  - Дальше текст и адреса уходят PATCH-ем: дебаунс 0,9 с и принудительно перед
 *    обложкой от ИИ, «Сохранить» и «Опубликовать» (`flush`). Запросы идут по
 *    цепочке, чтобы поздний ответ не затёр более новый.
 *  - Пригодность ролика каналам считаем на клиенте той же функцией, что и сервер
 *    (`evaluateVideoForChannels`), по фактам файла + подписи + живым лимитам.
 */

export interface ComposerProps {
  /** null — новый ролик; id — продолжить существующий черновик. */
  editId: string | null;
  onClose: () => void;
  /** Ролик отправлен на публикацию или поставлен по расписанию — показать его процесс. */
  onPublished: (id: string) => void;
  /** Открыть карточку другого ролика (предупреждение «этот файл уже загружали» → «Открыть прежний»). */
  onOpenVideo?: (id: string) => void;
}

interface Snapshot {
  title: string;
  caption: string;
  brief: string;
  destinations: SocialVideoDestination[];
}

type SaveState = "idle" | "saving" | "saved" | { error: string };

function Step({
  n,
  icon,
  title,
  hint,
  done,
  children,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  hint?: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card" aria-labelledby={`sv-step-${n}`}>
      <div className="sec-h stack">
        <h2 id={`sv-step-${n}`}>
          <span aria-hidden="true" style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 8 }}>
            {icon}
          </span>
          {n}. {title}
        </h2>
        {done ? <span className="chip ok">Готово</span> : hint ? <span className="note">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Composer({ editId, onClose, onPublished, onOpenVideo }: ComposerProps) {
  const [draftId, setDraftId] = useState<string | null>(editId);
  const draft = useSocialVideo(draftId).data ?? null;
  const infos = useSocialVideoChannels().data ?? [];
  const liveQuery = useSocialVideoChannelsLive();
  const refreshLive = useRefreshSocialVideoChannelsLive();
  const live = useMemo(() => liveByChannel(liveQuery.data), [liveQuery.data]);

  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [caption, setCaption] = useState("");
  const [tone, setTone] = useState<SocialVideoCaptionTone>("SELLING");
  const [language, setLanguage] = useState<SocialVideoCaptionLanguage>("RU");
  const [destinations, setDestinations] = useState<SocialVideoDestination[]>([]);
  const channels = useMemo(() => channelsOfDestinations(destinations), [destinations]);
  const [mode, setMode] = useState<"NOW" | "SCHEDULE">("NOW");
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [browserFacts, setBrowserFacts] = useState<SocialVideoFacts | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  /** Все байты ушли, сервер обрабатывает файл. */
  const [processing, setProcessing] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** Сервер нашёл такой же файл среди прежних роликов — предупреждаем, публикацию не блокируем. */
  const [duplicate, setDuplicate] = useState<SocialVideoDuplicate | null>(null);

  const [variants, setVariants] = useState<string[]>([]);
  const shownRef = useRef<string[]>([]);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"saving" | "publishing" | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [replaceRequest, setReplaceRequest] = useState<{ file: File | null; facts: SocialVideoFacts | null } | null>(null);

  const { mutateAsync: createAsync } = useCreateSocialVideo();
  const { mutateAsync: updateAsync } = useUpdateSocialVideo();
  const { mutateAsync: deleteAsync } = useDeleteSocialVideo();
  const { mutateAsync: publishAsync } = usePublishSocialVideo();
  const generateCaption = useGenerateSocialVideoCaption();
  const uploadCover = useUploadSocialVideoCover();
  const generateCover = useGenerateSocialVideoCover();
  const clearCover = useClearSocialVideoCover();

  // ── что известно серверу и что сейчас в форме ──
  const savedRef = useRef<Snapshot | null>(null);
  const valuesRef = useRef<Snapshot & { draftId: string | null }>({ title, caption, brief, destinations, draftId });
  useEffect(() => {
    valuesRef.current = { title, caption, brief, destinations, draftId };
  });
  const chain = useRef<Promise<void>>(Promise.resolve());
  const hydrated = useRef<string | null>(null);

  // Существующий черновик: один раз переносим его поля в форму.
  useEffect(() => {
    if (!draft || hydrated.current === draft.id) return;
    hydrated.current = draft.id;
    setTitle(draft.title);
    setBrief(draft.brief ?? "");
    setCaption(draft.caption);
    const draftDestinations = destinationsOfItem(draft);
    setDestinations(draftDestinations);
    if (draft.status === "SCHEDULED" && draft.scheduledAt) {
      setMode("SCHEDULE");
      setScheduledAt(draft.scheduledAt);
    }
    savedRef.current = { title: draft.title, caption: draft.caption, brief: draft.brief ?? "", destinations: draftDestinations };
  }, [draft]);

  /** Отправляет на сервер то, что изменилось с прошлого сохранения. Запросы — по цепочке. */
  const flush = useCallback((): Promise<void> => {
    const run = async () => {
      const cur = valuesRef.current;
      const saved = savedRef.current;
      if (!cur.draftId || !saved) return;
      const patch: { title?: string; caption?: string; brief?: string | null; destinations?: SocialVideoDestination[] } = {};
      const trimmedTitle = cur.title.trim();
      if (trimmedTitle && trimmedTitle !== saved.title) patch.title = trimmedTitle;
      if (cur.caption !== saved.caption) patch.caption = cur.caption;
      if (cur.brief.trim() !== saved.brief) patch.brief = cur.brief.trim() || null;
      if (!sameDestinations(cur.destinations, saved.destinations)) patch.destinations = cur.destinations;
      if (Object.keys(patch).length === 0) return;
      setSaveState("saving");
      try {
        await updateAsync({ id: cur.draftId, ...patch });
        // Запоминаем то, что реально ушло, а не то, что в форме к моменту ответа.
        savedRef.current = {
          title: patch.title ?? saved.title,
          caption: patch.caption ?? saved.caption,
          brief: patch.brief === undefined ? saved.brief : (patch.brief ?? ""),
          destinations: patch.destinations ?? saved.destinations,
        };
        setSaveState("saved");
      } catch (err) {
        setSaveState({ error: errorText(err, "Не удалось сохранить") });
        throw err;
      }
    };
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => undefined);
    return next;
  }, [updateAsync]);

  // Автосохранение: пауза в правках 0,9 с.
  useEffect(() => {
    if (!draftId || !savedRef.current) return;
    const timer = setTimeout(() => {
      void flush().catch(() => undefined);
    }, 900);
    return () => clearTimeout(timer);
  }, [title, caption, brief, destinations, draftId, flush]);

  // ── загрузка файла ──
  const upload = useCallback(
    async (f: File, nameForDraft: string) => {
      setUploadError(null);
      setDuplicate(null);
      setProgress(0);
      setProcessing(false);
      const cur = valuesRef.current;
      try {
        const item = await createAsync({
          file: f,
          title: nameForDraft,
          caption: cur.caption,
          brief: cur.brief.trim(),
          channels: channelsOfDestinations(cur.destinations),
          destinations: cur.destinations,
          onProgress: setProgress,
          onUploaded: () => setProcessing(true),
        });
        hydrated.current = item.id;
        savedRef.current = { title: item.title, caption: item.caption, brief: item.brief ?? "", destinations: destinationsOfItem(item) };
        setDraftId(item.id);
        setFile(null);
        setDuplicate(item.duplicateOf ?? null);
      } catch (err) {
        setUploadError(errorText(err, "Не удалось загрузить ролик"));
      } finally {
        setProgress(null);
        setProcessing(false);
      }
    },
    [createAsync]
  );

  const startWithFile = (f: File, facts: SocialVideoFacts | null) => {
    setFile(f);
    setBrowserFacts(facts);
    const name = title.trim() || titleFromFileName(f.name);
    if (!title.trim()) setTitle(name);
    void upload(f, name);
  };

  const onPick = (f: File, facts: SocialVideoFacts | null) => {
    // На сервере уже лежит файл этого черновика — заменить его можно только новым черновиком.
    if (draftId) setReplaceRequest({ file: f, facts });
    else startWithFile(f, facts);
  };

  const onClear = () => {
    if (draftId) setReplaceRequest({ file: null, facts: null });
    else {
      setFile(null);
      setBrowserFacts(null);
      setUploadError(null);
    }
  };

  const confirmReplace = async () => {
    const req = replaceRequest;
    setReplaceRequest(null);
    if (!req || !draftId) return;
    setUploadError(null);
    try {
      await flush().catch(() => undefined);
      await deleteAsync(draftId);
    } catch (err) {
      setUploadError(errorText(err, "Не удалось убрать прежний ролик"));
      return;
    }
    hydrated.current = null;
    savedRef.current = null;
    setDuplicate(null);
    setDraftId(null);
    setSaveState("idle");
    if (req.file) startWithFile(req.file, req.facts);
    else {
      setFile(null);
      setBrowserFacts(null);
    }
  };

  // ── факты и вердикты ──
  const facts = useMemo(
    () => mergeFacts(draft ? factsFromItem(draft) : null, browserFacts),
    [draft, browserFacts]
  );
  const verdicts = useMemo(() => {
    if (!facts) return [];
    const runtime: Partial<Record<SocialVideoChannel, ChannelRuntimeLimits>> = {};
    for (const c of SOCIAL_VIDEO_CHANNELS) {
      const r = live[c]?.runtime;
      if (r) runtime[c] = r;
    }
    return evaluateVideoForChannels(SOCIAL_VIDEO_CHANNELS, facts, caption, runtime);
  }, [facts, caption, live]);

  // ── подписи от ИИ ──
  const runGenerate = (regenerate: boolean) => {
    setGenerateError(null);
    const text = brief.trim();
    if (text.length < 3) {
      setGenerateError("Опишите ролик хотя бы парой слов — ИИ не из чего писать.");
      return;
    }
    generateCaption.mutate(
      {
        brief: text,
        title: title.trim() || undefined,
        tone,
        language,
        channels,
        avoid: regenerate ? shownRef.current.slice(-9) : [],
      },
      {
        onSuccess: (res) => {
          shownRef.current = [...shownRef.current, ...res.variants].slice(-9);
          setVariants(res.variants);
        },
        onError: (err) => setGenerateError(errorText(err, "Не удалось написать подписи")),
      }
    );
  };

  // ── обложка ──
  const coverBusy = uploadCover.isPending ? "upload" : generateCover.isPending ? "ai" : clearCover.isPending ? "clear" : null;
  const onCoverUpload = (f: File) => {
    if (!draftId) return;
    setCoverError(null);
    uploadCover.mutate({ id: draftId, file: f }, { onError: (err) => setCoverError(errorText(err, "Не удалось загрузить обложку")) });
  };
  const onCoverAi = (options: CoverAiOptions) => {
    if (!draftId) return;
    setCoverError(null);
    // ИИ берёт название и описание с сервера, если «что нарисовать» пусто, — отправляем свежие.
    void flush()
      .catch(() => undefined)
      .then(() =>
        generateCover.mutate(
          {
            id: draftId,
            prompt: options.prompt.trim() || undefined,
            provider: options.provider,
            useFrame: options.useFrame,
            useTrends: options.useTrends,
          },
          { onError: (err) => setCoverError(errorText(err, "Не удалось нарисовать обложку")) }
        )
      );
  };
  const onCoverClear = () => {
    if (!draftId) return;
    setCoverError(null);
    clearCover.mutate(draftId, { onError: (err) => setCoverError(errorText(err, "Не удалось убрать обложку")) });
  };

  // ── что мешает опубликовать ──
  const blockReasons: string[] = [];
  if (progress !== null) blockReasons.push("Ролик ещё загружается");
  else if (!draftId) blockReasons.push("Сначала загрузите ролик");
  if (destinations.length === 0) blockReasons.push("Выберите хотя бы один канал");
  blockReasons.push(...destinationBlockReasons(destinations, infos, verdicts));
  if (mode === "SCHEDULE") {
    if (!scheduledAt) blockReasons.push("Выберите дату и время публикации");
    else if (Date.parse(scheduledAt) < earliestScheduleMs()) {
      blockReasons.push(`Время должно быть не раньше чем через ${SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES} мин от сейчас`);
    }
  }

  const doPublish = async () => {
    setConfirmPublish(false);
    if (!draftId) return;
    if (mode === "SCHEDULE" && scheduledAt && Date.parse(scheduledAt) < earliestScheduleMs()) {
      setActionError(`Время уже слишком близко: выберите не раньше чем через ${SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES} мин.`);
      return;
    }
    setActionError(null);
    setBusy("publishing");
    try {
      await flush();
      const item = await publishAsync({
        id: draftId,
        mode,
        scheduledAt: mode === "SCHEDULE" ? (scheduledAt ?? undefined) : undefined,
        destinations,
      });
      onPublished(item.id);
    } catch (err) {
      setActionError(errorText(err, "Не удалось отправить ролик на публикацию"));
    } finally {
      setBusy(null);
    }
  };

  const saveDraftAndClose = async () => {
    setActionError(null);
    setBusy("saving");
    try {
      await flush();
      toast.success("Черновик сохранён");
      onClose();
    } catch (err) {
      setActionError(errorText(err, "Не удалось сохранить черновик"));
    } finally {
      setBusy(null);
    }
  };

  const openDuplicate = async () => {
    if (!duplicate || !onOpenVideo) return;
    await flush().catch(() => undefined);
    onOpenVideo(duplicate.id);
  };

  const leave = async () => {
    await flush().catch(() => undefined);
    onClose();
  };

  const saveNote =
    saveState === "saving" ? "Сохраняем…" : saveState === "saved" ? "Черновик сохранён" : typeof saveState === "object" ? saveState.error : null;
  const coverUrl = draft?.coverUrl ? mediaSrc(draft.coverUrl) : null;
  const selectedVerdicts = verdicts.filter((v) => channels.includes(v.channel));
  const uploading = progress !== null;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <button className="pill ghost sm" type="button" onClick={() => void leave()} disabled={uploading}>
              <ArrowLeft className="i" aria-hidden />К списку роликов
            </button>
            <h1 style={{ marginTop: 12 }}>{editId ? "Редактирование ролика" : "Новый ролик"}</h1>
            <p className="sub">
              Загрузите ролик, опишите его своими словами — ИИ напишет подписи. Выберите сети и время: сразу или по
              расписанию. Публикация идёт в фоне, её ход виден в карточке ролика.
            </p>
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

        {duplicate && (
          <div className="quiet warn" role="status">
            <AlertTriangle className="i" aria-hidden />
            <span className="txt">
              Этот файл уже загружали: «{duplicate.title}» ({SOCIAL_VIDEO_STATUS_LABELS[duplicate.status]},{" "}
              {exactDateTime(duplicate.createdAt)}).{" "}
              {duplicate.publishedTo.length > 0 ? `Уже вышел: ${duplicate.publishedTo.join(", ")}.` : "В соцсети он ещё не выходил."}
            </span>
            {onOpenVideo && (
              <button className="pill ghost sm" type="button" onClick={() => void openDuplicate()}>
                Открыть прежний
              </button>
            )}
            <button className="pill ghost sm" type="button" onClick={() => setDuplicate(null)}>
              Всё равно использовать новый
            </button>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <Step n={1} icon={<Film className="i" />} title="Ролик" done={!!draftId && !uploading} hint="MP4, MOV или M4V">
              <VideoDropzone
                file={file}
                existing={draft ? { videoPath: draft.videoPath, originalName: draft.originalName, sizeBytes: draft.sizeBytes } : null}
                facts={facts}
                uploadProgress={progress}
                processing={processing}
                disabled={uploading}
                onPick={onPick}
                onClear={onClear}
              />
              {uploadError && (
                <div className="quiet crit" role="alert" style={{ marginTop: 12 }}>
                  <span className="dot crit" />
                  <span className="txt">{uploadError}</span>
                  {file && !uploading && (
                    <button className="pill ghost sm" type="button" onClick={() => void upload(file, title.trim() || titleFromFileName(file.name))}>
                      <RefreshCw className="i" aria-hidden />
                      Загрузить ещё раз
                    </button>
                  )}
                </div>
              )}
              {verdicts.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="sec-t">Подходит ли ролик сетям</div>
                  <VerdictChips verdicts={verdicts} selected={channels} />
                </div>
              )}
            </Step>

            <Step n={2} icon={<PenLine className="i" />} title="Текст" done={caption.trim().length > 0}>
              <CaptionStudio
                title={title}
                onTitleChange={setTitle}
                brief={brief}
                onBriefChange={setBrief}
                caption={caption}
                onCaptionChange={setCaption}
                tone={tone}
                onToneChange={setTone}
                language={language}
                onLanguageChange={setLanguage}
                channels={channels}
                variants={variants}
                generating={generateCaption.isPending}
                generateError={generateError}
                onGenerate={() => runGenerate(false)}
                onRegenerate={() => runGenerate(true)}
                onPickVariant={setCaption}
              />
            </Step>

            <Step n={3} icon={<ImageIcon className="i" />} title="Обложка" hint="необязательно">
              {!draftId && (
                <p className="state" style={{ paddingTop: 0 }}>
                  Обложку можно добавить после загрузки ролика.
                </p>
              )}
              <CoverPicker
                mode={draft?.coverMode ?? "NONE"}
                coverUrl={coverUrl}
                busy={coverBusy}
                error={coverError}
                disabled={!draftId || uploading}
                onUpload={onCoverUpload}
                onGenerateAi={onCoverAi}
                onClear={onCoverClear}
                coverMeta={draft?.coverMeta ?? null}
              />
            </Step>

            <Step n={4} icon={<Share2 className="i" />} title="Куда публиковать" done={destinations.length > 0}>
              <ChannelPicker
                infos={infos}
                live={live}
                liveLoading={liveQuery.isLoading || refreshLive.isPending}
                verdicts={verdicts}
                selected={destinations}
                onChange={setDestinations}
                disabled={uploading}
              />
              <div className="acts" style={{ marginTop: 12 }}>
                <button className="pill ghost sm" type="button" disabled={refreshLive.isPending} onClick={() => refreshLive.mutate()}>
                  <RefreshCw className="i" aria-hidden />
                  {refreshLive.isPending ? "Спрашиваем площадки…" : "Обновить данные площадок"}
                </button>
                {refreshLive.isError && (
                  <span className="note" role="alert">
                    {errorText(refreshLive.error, "Площадки не ответили")}
                  </span>
                )}
              </div>
            </Step>

            <Step n={5} icon={<CalendarClock className="i" />} title="Когда" done={mode === "NOW" || !!scheduledAt}>
              <SchedulePicker
                mode={mode}
                onModeChange={setMode}
                scheduledAt={scheduledAt}
                onScheduledAtChange={setScheduledAt}
                disabled={uploading}
              />
            </Step>
          </div>

          <div className="lg:sticky lg:top-4">
            <ComposerSummary
              title={title}
              facts={facts}
              selected={destinations}
              infos={infos}
              verdicts={selectedVerdicts}
              live={live}
              mode={mode}
              scheduledAt={scheduledAt}
              hasCover={!!coverUrl}
              blockReasons={blockReasons}
              busy={busy}
              saveNote={saveNote}
              canSaveDraft={!!draftId && !uploading}
              onSaveDraft={() => void saveDraftAndClose()}
              onPublish={() => setConfirmPublish(true)}
            />
          </div>
        </div>
      </div>

      {confirmPublish && (
        <ConfirmDialog
          danger={false}
          title={mode === "NOW" ? "Опубликовать ролик?" : "Запланировать ролик?"}
          description={
            mode === "NOW"
              ? `Ролик «${title.trim()}» уйдёт сразу по ${destinations.length} ${pluralizeRu(destinations.length, ["адресу", "адресам", "адресам"])}. Вышедшие посты потом убирают в самих соцсетях.`
              : `Ролик «${title.trim()}» выйдет ${scheduledAt ? exactDateTime(scheduledAt) : ""} по Душанбе по ${destinations.length} ${pluralizeRu(destinations.length, ["адресу", "адресам", "адресам"])}. До этого времени его можно вернуть в черновик.`
          }
          confirmLabel={mode === "NOW" ? "Опубликовать" : "Запланировать"}
          onConfirm={() => void doPublish()}
          onCancel={() => setConfirmPublish(false)}
        >
          <div className="list">
            {destinations.map((d) => (
              <div className="row" key={destinationKeyOf(d)}>
                <ChannelBadge channel={d.channel} size={28} label={destinationLabel(d, infos)} />
                <div className="t">
                  <b>{destinationLabel(d, infos)}</b>
                  <span>{verdicts.find((v) => v.channel === d.channel)?.format ?? "формат уточнится после загрузки"}</span>
                </div>
              </div>
            ))}
          </div>
        </ConfirmDialog>
      )}

      {replaceRequest && (
        <ConfirmDialog
          title={replaceRequest.file ? "Заменить ролик?" : "Убрать ролик?"}
          description="Прежний файл вместе с загруженной обложкой удалится, а текст и выбранные каналы останутся. Если ролик уже стоял в расписании, расписание пропадёт."
          confirmLabel={replaceRequest.file ? "Заменить" : "Убрать"}
          onConfirm={() => void confirmReplace()}
          onCancel={() => setReplaceRequest(null)}
        />
      )}
    </div>
  );
}

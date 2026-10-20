import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRetryKey } from "../../hooks/useRetryKey";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { PropertyDraftView } from "@royal-home/shared";
import { useDistricts } from "../../hooks/useDistricts";
import { useCreateProperty } from "../../hooks/useProperties";
import { PROPERTY_DRAFT_QUERY_KEY } from "../../hooks/usePropertyDraft";
import { clearFormDraft, loadFormDraft, loadFormDraftSnapshot } from "../../hooks/useFormDraft";
import { useWizardLocalDraft, WIZARD_LOCAL_DRAFT_TTL_MS } from "./useWizardLocalDraft";
import { useServerAutosave } from "./useServerAutosave";
import type { WizardDraftStatus } from "./draftAutosave";
import { recoverDraftValues } from "./recoverDraftValues";
import {
  adoptPropertyDraftSession, ensurePropertyDraftSession, getPropertyDraftSession,
  invalidatePropertyDraftSession, loadPropertyDraftSession,
  isPropertyDraftSessionCurrent, propertyDraftSessionToken, type PropertyDraftSession,
} from "../../lib/propertyDraftSession";
import { useDraftMedia, useDraftPhotoLocation, summarizeDraftMedia } from "../../hooks/useDraftMedia";
import { snapNote, fetchHouseSnap } from "../../lib/houseSnap";
import { useAuthStore } from "../../store/auth";
import { useCan } from "../../lib/permissions";
import { api } from "../../lib/api";
import { takePendingMapPin, type PendingMapPin } from "../../lib/pendingMapPin";
import { ApiError } from "../../lib/apiError";
import {
  canRetryDraftItem,
  clearDraftMedia,
  detachDraftMediaView,
  getDraftMediaSnapshot,
  hasLiveDraftMedia,
  hydrateDraftMedia,
  removeDraftMedia,
  retryDraftMedia,
  waitForDraftUploads,
} from "../../lib/draftUploads";
import { registerWork } from "../../lib/workGuard";
import { setDraftReminder } from "../../lib/draftReminder";
import { toast } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { canCloseWizard, decideSave, skippedMediaCount, skippedMediaMessage } from "./saveDecision";
import { SaveProgressOverlay } from "./SaveProgressOverlay";
import { UploadProblemSheet } from "./UploadProblemSheet";
import { draftMediaConflict, draftMediaConflictTitle } from "./draftMediaConflict";
import { WizardShell } from "./WizardShell";
import { wizardProgress } from "./wizardProgress";
import { focusWizardError } from "./focusWizardError";
import { DraftGate, type OfferedDraft } from "./DraftGate";
import { StepMedia } from "./StepMedia";
import { StepMain } from "./StepMain";
import { StepPlace } from "./StepPlace";
import { StepSeller } from "./StepSeller";
import { StepReview } from "./StepReview";
import { runRestartDraft } from "./restartDraft";
import {
  buildCreateBody,
  EMPTY_WIZARD_VALUES,
  fillEmptyFromDraftValues,
  firstIncompleteStep,
  isWizardEmpty,
  stepIndexOf,
  validateAll,
  validateStep,
  WIZARD_STEPS,
  type WizardValues,
} from "./types";

/**
 * МАСТЕР ДОБАВЛЕНИЯ ОБЪЕКТА — пять шагов, заполняется стоя в квартире.
 *
 * ЧЕРНОВИК ЖИВЁТ НА СЕРВЕРЕ (11.09.2026, владелец: «черновик сделай»). Раньше он
 * лежал в localStorage: не переживал смену устройства и не мог держать файлы —
 * Blob туда не сериализуется. А файлы и есть главное: агент снимает квартиру
 * телефоном, а дозаполняет карточку вечером с ноутбука. Теперь поля уезжают в
 * PropertyDraft автосохранением, файлы — сразу в тот же черновик
 * (lib/draftUploads.ts), и при возврате всё на месте, с любого устройства.
 *
 * localStorage остался ЗАПАСНЫМ путём на случай, когда сервера не слышно
 * (подъезд, лифт, метро): автосохранение молча не доедет, и без запасной копии
 * двадцать введённых полей исчезли бы при выгрузке вкладки. Источник правды при
 * восстановлении один и приоритет однозначный: сначала черновик сервера, и
 * только если его нет — снимок из браузера.
 *
 * ОБЪЕКТ ПО-ПРЕЖНЕМУ СОЗДАЁТСЯ В КОНЦЕ, А НЕ ЧЕРНОВИКОМ-ОБЪЕКТОМ. Статуса
 * «черновик» у Property нет (PropertyStatus начинается с PENDING_REVIEW — это
 * уже конвейер подготовки), колонки districtId/address/areaSqm/price NOT NULL, а
 * брошенный на середине объект повис бы настоящей карточкой в конвейере — тот
 * самый класс «осиротевших спутников». Поэтому черновик — отдельная сущность, а
 * кнопка «Сохранить» создаёт объект и переносит в него уже отданные файлы одним
 * запросом (POST /properties с draftId).
 *
 * ВОПРОС «ПРОДОЛЖИТЬ?» — ВСЕГДА ПЕРВЫЙ ЭКРАН, БЛОКИРУЮЩИЙ (владелец
 * 21.09.2026). Раньше предложение рисовалось карточкой НАД шагами, а шаги под
 * ней уже были живые — на них можно было листать фото, пока агент ещё не решил,
 * тот ли это черновик; `autosaveArmed` при этом молчал, и «Начать заново»
 * бесшумно сносило только что добавленные файлы. Теперь, пока есть что
 * спросить, вместо шагов рисуется `DraftGate` — ни один шаг и ни одна кнопка
 * добавления файла не существуют в дереве, пока агент не ответил. Вопрос не
 * показывается вовсе (черновик подхватывается сразу, слиянием), если решение
 * уже известно: `autoContinueDraft` (кнопка «Продолжить» с баннера на списке
 * объектов, `?draft=continue`) или `hasLiveDraftMedia()` — в очереди уже есть
 * плитки/едущие файлы прошлого захода (мастер закрывали, не дождавшись
 * отдачи, — спрашивать «продолжить?» в этом случае бессмысленно, продолжать
 * можно только его).
 */
export function PropertyWizard({
  onClose,
  initialIntakeAgentId,
  autoContinueDraft,
  fromClientId,
}: {
  onClose: () => void;
  /** Предзаполнить принявшего объект — вход из заявки продавца (?intake=…). */
  initialIntakeAgentId?: string;
  /** Пропустить вопрос «продолжить?» и сразу подхватить черновик — переход из
   *  баннера черновика на списке объектов, где агент уже ответил. */
  autoContinueDraft?: boolean;
  /**
   * Вход «Добавить объект» из чата продавца (21.09.2026, `?fromClient=<id>`,
   * см. PropertyForm.tsx::PropertyNew). Мастер сразу заводит серверный
   * черновик из фактов и фото переписки продавца (POST
   * /properties/drafts/from-client/:clientId) и открывается уже заполненным —
   * ни вопроса «продолжить?», ни экрана подтверждения, ни меток «из ИИ» (владелец:
   * «поля просто заполнены»). Единственный вопрос — если у агента уже лежат
   * СВОИ фото другого объекта: «Заменить N загруженных фото на фото из
   * переписки?» (задаёт сервер ответом 409, см. mediaConflict ниже).
   */
  fromClientId?: string;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const agentId = useAuthStore((s) => s.agent?.id);
  const draftKey = agentId ? `property-wizard:${agentId}` : null;

  const { data: districts, isLoading: districtsLoading } = useDistricts();
  // Один ключ на всё время мастера: второе «Сохранить» после обрыва связи
  // получает уже созданный объект, а не дубль (hooks/useRetryKey.ts).
  const createKey = useRetryKey();
  const create = useCreateProperty(createKey);
  const pendingCreateBody = useRef<Record<string, unknown> | null>(null);
  // Руководитель обязан указать интейкера явно; рядовому агенту сервер
  // подставляет его самого (routes/properties/crud.ts).
  const requireIntakeAgent = can("properties.editForeign");

  const [values, setValues] = useState<WizardValues>(() => ({
    ...EMPTY_WIZARD_VALUES,
    intakeAgentId: initialIntakeAgentId ?? "",
  }));
  const sellerSelectionRef = useRef(values.sellerClientId);
  sellerSelectionRef.current = values.sellerClientId;
  const sellerSelectionGeneration = useRef(0);
  const sellerImportLocked = useRef(false);
  const [sellerImportPending, setSellerImportPending] = useState(false);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Совпадение по адресу+площади — только настоящий ответ сервера (409 при
   *  сохранении, DuplicatePropertyError в routes/properties/crud.ts). Живой
   *  проверки заранее нет, поэтому появляется только ПОСЛЕ попытки сохранить. */
  const [duplicate, setDuplicate] = useState<{ shortId: number; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [waitingUploads, setWaitingUploads] = useState(false);
  /**
   * Финальный экран загрузки (07.10.2026): полноэкранный список файлов, пока они
   * едут и пока создаётся объект; «Готово» — только когда всё доехало. null — не
   * показан (файлов не было или все уже были на сервере к моменту «Сохранить»).
   */
  const [finishing, setFinishing] = useState<{ phase: "uploading" | "creating" | "done"; shortId?: number } | null>(null);
  /** Окно «не загрузилось N файлов: повторить / убрать / сохранить без них». */
  const [uploadProblem, setUploadProblem] = useState<{ timedOut: boolean } | null>(null);
  /** Мастер ещё на экране: после ухода таймеры и create/navigate не срабатывают «зомби». */
  const mountedRef = useRef(true);
  const saveAbortRef = useRef<AbortController | null>(null);
  /** Идёт save() — второй вызов (двойной тап, «Повторить» из окна) не запускаем. */
  const savingRef = useRef(false);
  /** Предложение продолжить: null — предлагать нечего (или уже ответили). */
  const [offered, setOffered] = useState<OfferedDraft | null>(null);
  // «Начать заново» идёт и/или упало (WEB-05): гейт показывает ожидание и причину отказа.
  const [restartState, setRestartState] = useState<{ pending: boolean; error: string | null }>({
    pending: false,
    error: null,
  });
  /**
   * ОТВЕТ ПРО ЧЕРНОВИК ЕЩЁ НЕ ПРИШЁЛ — ШАГОВ НЕ ПОКАЗЫВАЕМ (22.09.2026).
   *
   * Заслонка черновика (`DraftGate`) блокирует всё дерево шагов, но появляется
   * она только ПОСЛЕ ответа сервера на GET /properties/drafts/current. До
   * ответа мастер рисовался полностью и был живым: на медленной мобильной сети
   * агент успевал открыть «Новый объект», начать заполнять поля и добавлять
   * фото — и получал заслонку поверх набранного. Дальше работа терялась молча
   * в обе стороны: «Продолжить» подменяло набранное старым черновиком,
   * «Начать заново» стирало и то и другое. Поймано e2e (wizard-map.spec.ts:
   * шкала шагов есть, а через секунду вместо неё заслонка).
   *
   * Поэтому до ответа — тихое ожидание вместо шагов. Без агента (`agentId`
   * пуст) спрашивать некого и ждать нечего.
   *
   * То же окно открывает вход `?fromClient=` (21.09.2026): ответ про черновик
   * уже пришёл, а POST /properties/drafts/from-client/:id ещё в пути, и его
   * setValues точно так же затрёт набранное. Поэтому startFromClient гасит
   * `draftChecked` на время своего запроса и поднимает в finally.
   */
  const [draftChecked, setDraftChecked] = useState(false);
  /** id черновика на сервере — уходит вместе с POST /properties. */
  const draftIdRef = useRef<string | null>(null);
  /** Пока агент не ответил на «продолжить?», автосохранение молчит: иначе оно
   *  затёрло бы предложенный черновик пустой формой быстрее, чем его прочитают. */
  const [autosaveArmed, setAutosaveArmed] = useState(false);
  // Строка «Черновик сохранён» в шапке (артефакт 15.09.2026) — только когда
  // автосохранение реально только что отработало, а не заранее нарисованная
  // на весь мастер: до первого успешного PUT её быть не должно.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [clientDraftConflict, setClientDraftConflict] = useState<{ clientId: string; draft: PropertyDraftView } | null>(null);

  // Вход `?fromClient=` (21.09.2026) обрабатывается РОВНО ОДИН РАЗ за открытие
  // мастера — тем же приёмом, что и useServerDraft.done ниже: StrictMode
  // прогоняет эффекты дважды, а второй поход на POST .../from-client/:id
  // затёр бы уже применённый ответ первого.
  const fromClientHandledRef = useRef(false);
  /**
   * «ЗАМЕНИТЬ N ЗАГРУЖЕННЫХ ФОТО НА ФОТО ИЗ ПЕРЕПИСКИ?» (решение владельца
   * 02.10.2026, «да, по советам», глубокая проверка D14). Сервер больше не
   * заменяет файлы агента молча: если в черновике уже лежат фото другого
   * объекта (другой продавец или набранные руками), POST .../from-client/:id
   * отвечает 409 DRAFT_MEDIA_REPLACE_CONFIRM, ничего не тронув. Мастер
   * спрашивает и повторяет запрос с ответом: «Да» — `media: "replace"`, «Нет»
   * (и любое закрытие окна) — `media: "keep"`: фото агента остаются, фото из
   * переписки не подмешиваются. Два входа: `?fromClient=` (start) и выбор
   * продавца на шаге «Продавец» (enrich).
   */
  const [mediaConflict, setMediaConflict] = useState<{
    clientId: string;
    mode: "start" | "enrich";
    replaceValues?: boolean;
    photoCount: number;
    videoCount: number;
  } | null>(null);

  const media = useDraftMedia();
  const mediaSummary = useMemo(() => summarizeDraftMedia(media), [media]);

  /**
   * ОБЛОЖКА (владелец 12.09.2026: «тап по плитке делает её обложкой»).
   *
   * Ключ выбранного снимка держим ОТДЕЛЬНО от WizardValues/автосохранения
   * черновика, а не полем формы: черновик хранит File'ы только на сервере
   * (lib/draftUploads.ts, трогать нельзя), а порядок снимков в БД неизвестен
   * клиенту до ответа сервера — держать здесь что-то более сложное, чем ключ
   * отправки, было бы обманом. Пока агент не тронул плитки, обложка — первый
   * снимок, тем же способом, каким она была прибита раньше.
   */
  const [manualCoverKey, setManualCoverKey] = useState<string | null>(null);
  const coverUploadKey =
    manualCoverKey && mediaSummary.photos.some((p) => p.uploadKey === manualCoverKey)
      ? manualCoverKey
      : (mediaSummary.photos[0]?.uploadKey ?? null);

  useServerDraft({
    enabled: !!agentId,
    onLoaded: (draft) => {
      setDraftChecked(true);
      // Плашка «Черновик объекта · Продолжить»: сервер подтвердил, что черновик
      // есть (или что его нет и файлы в очереди тоже не лежат).
      if (draft) setDraftReminder(true);
      else if (!hasLiveDraftMedia()) setDraftReminder(false);
      // ВХОД `?fromClient=` — своя ветка, ПЕРЕД обычной логикой «продолжить
      // черновик»: макет прямо запрещает спрашивать про прошлый черновик,
      // кроме единственного случая — в нём уже лежат фото другого объекта, и
      // тогда спрашивает сам сервер (409, см. mediaConflict и рендер ниже).
      if (fromClientId && !fromClientHandledRef.current) {
        fromClientHandledRef.current = true;
        if (draft) draftIdRef.current = draft.id;
        void startFromClient(fromClientId);
        return;
      }
      if (draft) {
        draftIdRef.current = draft.id;
        const localSnapshot = draftKey ? loadFormDraftSnapshot<WizardValues>(draftKey, WIZARD_LOCAL_DRAFT_TTL_MS) : null;
        const recovered = recoverDraftValues(draft, localSnapshot);
        const localConflict = recovered !== draft && !!localSnapshot?.context?.dirty &&
          (localSnapshot.context.draftId !== draft.id || (localSnapshot.context.baseRevision ?? -1) < draft.revision);
        const notice = recovered !== draft ? localConflict
          ? "На устройстве остались несохранённые поля, а версия сервера изменилась. Ниже показана местная копия. «Продолжить» восстановит её поверх версии сервера."
          : "Восстановлены более свежие изменения, сохранённые на этом устройстве." : undefined;
        // «Продолжить» уже нажали на баннере списка объектов, или в очереди
        // уже едут/лежат плитки прошлого захода (мастер закрывали, не
        // дождавшись отдачи) — решение известно, спрашивать не за чем.
        if ((autoContinueDraft || hasLiveDraftMedia()) && !localConflict) {
          applyOffer({ source: "server", draft: recovered });
          return;
        }
        setOffered({ source: "server", draft: recovered, notice });
        return;
      }
      // Сервер черновика не знает — смотрим запасную копию в браузере.
      const local = draftKey ? loadFormDraft<WizardValues>(draftKey, WIZARD_LOCAL_DRAFT_TTL_MS) : null;
      if (local && !isWizardEmpty(local)) {
        if (autoContinueDraft) {
          applyOffer({ source: "local", values: local });
          return;
        }
        setOffered({ source: "local", values: local });
        return;
      }
      setAutosaveArmed(true);
    },
    onFailed: () => {
      setDraftChecked(true);
      if (fromClientId && !fromClientHandledRef.current) {
        fromClientHandledRef.current = true;
        // Сеть/сервер не ответили даже на проверку прошлого черновика —
        // пробуем всё равно завести объект из чата; startFromClient сам
        // деградирует молча, если и этот запрос не пройдёт.
        void startFromClient(fromClientId);
        return;
      }
      // Сервер не ответил — работаем как раньше, по запасной копии.
      const local = draftKey ? loadFormDraft<WizardValues>(draftKey, WIZARD_LOCAL_DRAFT_TTL_MS) : null;
      if (local && !isWizardEmpty(local)) {
        if (autoContinueDraft) {
          applyOffer({ source: "local", values: local });
          return;
        }
        setOffered({ source: "local", values: local });
      } else setAutosaveArmed(true);
    },
  });

  // Запасная копия пишется только после армирования: до ответа сервера значения
  // стартовые, и без этого копия прошлого захода стиралась раньше, чем её читали.
  // created: объект уже создан — черновик больше не пишем вовсе. Иначе
  // досылка при уходе со страницы заводила черновик заново из данных только
  // что созданного объекта, и баннер предлагал «продолжить» — путь к дублю.
  const [created, setCreated] = useState(false);
  const localPersisted = useWizardLocalDraft(draftKey, draftChecked && !offered && !clientDraftConflict && !mediaConflict && !created, values, getPropertyDraftSession()?.draft);
  const autosave = useServerAutosave(autosaveArmed && !saving && !created, values, step, draftIdRef);
  const visibleDraftStatus: WizardDraftStatus | undefined = isWizardEmpty(values) && !draftIdRef.current ? undefined
    : autosave.status.state === "local" && localPersisted !== true
      ? localPersisted === false ? { state: "error", message: "Не удалось сохранить изменения на этом устройстве. Проверьте связь и сохраните черновик на сервере" } : undefined
      : autosave.status;

  // Смена шага — как смена экрана: страница обязана начаться сверху. Без этого
  // агент после длинного первого шага попадал на второй, прокрученный к его
  // середине, и не видел ни заголовка, ни первых полей.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  // Мастер закрыли — вкладка отписывается от очереди, но НЕ отменяет едущие
  // файлы (contract lib/draftUploads.ts::detachDraftMediaView, 21.09.2026):
  // раньше clearDraftMedia() здесь молча обрывала ролик на середине отдачи,
  // если агент закрыл мастер, не дождавшись прогресса. Явная очистка
  // («Начать заново», успешное сохранение) по-прежнему зовёт clearDraftMedia().
  useEffect(() => () => detachDraftMediaView(), []);

  // Выход с экрана: ожидание файлов в save() прерывается, create/navigate не зовутся.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveAbortRef.current?.abort();
    };
  }, []);

  const patch = useCallback((p: Partial<WizardValues>) => {
    setValues((v) => ({ ...v, ...p }));
    setSaveError(null);
  }, []);
  const patchSeller = useCallback((p: Partial<WizardValues>) => {
    // A stale event handler can run before the disabled fieldset is committed.
    // Lock synchronously, rather than relying only on React's next render.
    if (sellerImportLocked.current) return;
    if (p.sellerClientId !== undefined && p.sellerClientId !== sellerSelectionRef.current) {
      sellerSelectionGeneration.current++;
      sellerSelectionRef.current = p.sellerClientId;
    }
    patch(p);
  }, [patch]);

  /**
   * ТОЧКА С ДОЛГОГО ТАПА НА КАРТЕ ОБЪЕКТОВ (перенос макета 14.09.2026).
   * `PropertiesMap.tsx::handleLongPress` кладёт координату в `sessionStorage` и
   * обещает тостом «точка уже на руках у мастера» — мастер эту запись читает
   * здесь, один раз за открытие.
   *
   * Точку держим в ref, а не только подставляем в values: предложение
   * «продолжить черновик» (`useServerDraft` → `acceptOffer`) приходит ПОЗЖЕ
   * этого эффекта и заменяет values целиком — без ref координата, подставленная
   * на монтировании, молча пропадала бы у всех, у кого есть незакрытый черновик,
   * а запись в sessionStorage к тому моменту уже стёрта. Поэтому после
   * принятия черновика точка накладывается второй раз — но только на пустое
   * место: координата самого черновика всегда главнее.
   */
  const pendingPinRef = useRef<PendingMapPin | null>(null);

  const withPendingPin = useCallback((v: WizardValues): WizardValues => {
    const pin = pendingPinRef.current;
    if (!pin || v.lat !== null || v.lng !== null) return v;
    return { ...v, lat: pin.lat, lng: pin.lng };
  }, []);

  useEffect(() => {
    const pin = takePendingMapPin();
    if (!pin) return;
    pendingPinRef.current = pin;
    setValues((v) => (v.lat === null && v.lng === null ? { ...v, lat: pin.lat, lng: pin.lng } : v));
  }, []);

  /**
   * ТОЧКА ПО EXIF ПЕРВОГО СНИМКА (владелец 17.09.2026, живая жалоба: карта на
   * шаге «Где» просила геопозицию агента вместо того, чтобы взять её с уже
   * выбранного фото объекта). Разбор — в браузере, сразу как фото выбрано
   * (lib/exifGps.ts, hooks/useDraftMedia.ts::useDraftPhotoLocation), без похода
   * на сервер. `values.lat === null` — не перетираем точку, которую агент уже
   * поставил рукой или подтянул черновик: EXIF — это подсказка для ПУСТОЙ
   * карты, а не команда "переставь".
   */
  const photoLocation = useDraftPhotoLocation();
  /**
   * Точка по фото — сразу на дом (28.09.2026, владелец: «по EXIF на пару метров
   * в дорогу ввёл, и не выходит номер дома»). GPS в помещении уходит на улицу;
   * справочник находит дом рядом и отдаёт точку внутри него (lib/houseSnap.ts).
   * `photoPinRef` — какую точку поставило фото: пока метка там и стоит (агент её
   * не двигал), следующий снимок уточняет её (точка — медиана по всем кадрам,
   * lib/draftUploads.ts). Сдвинул агент — фото больше ничего не трогает.
   */
  const photoPinRef = useRef<{ lat: number; lng: number } | null>(null);
  const [photoSnap, setPhotoSnap] = useState<{ lat: number; lng: number; note: string } | null>(null);
  useEffect(() => {
    if (!photoLocation) return;
    const own = photoPinRef.current;
    const untouched = values.lat === null && values.lng === null;
    const stillOurs = own !== null && values.lat === own.lat && values.lng === own.lng;
    if (!untouched && !stillOurs) return;
    photoPinRef.current = { lat: photoLocation.lat, lng: photoLocation.lng };
    setPhotoSnap(null);
    patch({ lat: photoLocation.lat, lng: photoLocation.lng });
    const asked = photoPinRef.current;
    void fetchHouseSnap(photoLocation.lat, photoLocation.lng).then((snapped) => {
      // Пока ждали ответ, агент сдвинул метку или пришёл новый снимок — не трогаем.
      if (!snapped || photoPinRef.current !== asked) return;
      const onHouse = { lat: snapped.lat, lng: snapped.lng };
      setValues((v) => {
        if (v.lat !== asked.lat || v.lng !== asked.lng) return v;
        photoPinRef.current = onHouse;
        return { ...v, lat: onHouse.lat, lng: onHouse.lng };
      });
      setPhotoSnap({ ...onHouse, note: snapNote(snapped, "photo") });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoLocation]);
  const photoSnapNote =
    photoSnap && values.lat === photoSnap.lat && values.lng === photoSnap.lng ? photoSnap.note : null;

  /**
   * КООРДИНАТЫ ЗАКРЫТОГО ОБЪЕКТА — С ТЕЛЕФОНА, БЕЗ ВОПРОСА (владелец 14.09.2026).
   *
   * «Только для своих» больше не спрашивает район и адрес — риск остаться без
   * них и выпасть из карты/подбора/поиска по улице закрывает сервер сам
   * (routes/properties/crud.ts: lookupGeoPoint по точке). Точка нужна ОТСЮДА,
   * и агент её не вводит — он стоит в объекте, поэтому геопозиция браузера и
   * есть координаты объекта.
   *
   * ОДИН ЗАПРОС, ДЕЛИКАТНО: пробуем ровно один раз за сессию мастера (`askedRef`),
   * как только включён offSite и точки ещё нет. Отказ или таймаут не показывает
   * ошибку и не мешает заполнению — просто lat/lng остаются null, а сервер потом
   * создаст объект без адреса как есть (сам предупредит об этом в карточке).
   * Шаг «Где» здесь не показывает карту вовсе (StepPlace) — второй раз спрашивать
   * позицию для НЕЁ нечем, а если точка уже пришла картой (обычный объект,
   * переключённый в offSite) — используем то, что уже есть, и не спрашиваем снова.
   */
  const geoAskedRef = useRef(false);
  useEffect(() => {
    if (!values.offSite) return;
    if (values.lat !== null && values.lng !== null) return;
    if (geoAskedRef.current) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    geoAskedRef.current = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => patch({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {
        /* отказ или таймаут — молча продолжаем без точки, не переспрашиваем */
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, [values.offSite, values.lat, values.lng, patch]);

  function goNext() {
    if (sellerImportLocked.current) return;
    const stepErrors = validateStep(WIZARD_STEPS[step].key, values, { requireIntakeAgent });
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) { focusWizardError(); return; }
    if (step < WIZARD_STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    void save();
  }

  /**
   * «СОХРАНИТЬ» (07.10.2026, владелец: «ролики и фото всегда дозагружались, и
   * агент видел процесс»). Объект НЕ создаётся, пока что-то едет; если после
   * ожидания остались упавшие или потерянные файлы — молча не создаём, а
   * спрашиваем (UploadProblemSheet). «Сохранить без них» — `acceptedLoss`,
   * только явным нажатием. Решение — чистая функция `decideSave`.
   */
  async function save(opts: { acceptedLoss?: boolean } = {}) {
    if (sellerImportLocked.current) return;
    if (savingRef.current) return;
    const all = validateAll(values, { requireIntakeAgent });
    setErrors(all);
    if (Object.keys(all).length > 0) {
      setStep(firstIncompleteStep(values, { requireIntakeAgent }));
      focusWizardError();
      return;
    }

    savingRef.current = true;
    try {
      await runSave(opts);
    } finally {
      savingRef.current = false;
    }
  }

  async function runSave(opts: { acceptedLoss?: boolean }) {
    setSaveError(null);
    setDuplicate(null);
    setUploadProblem(null);

    const abort = new AbortController();
    saveAbortRef.current = abort;
    let showedProgress = false;

    // Файлы ещё едут — не бросаем их. Раньше кнопка просто создавала объект, и
    // всё, что не успело уйти, пропадало молча; блокировать кнопку тоже нельзя
    // (мёртвая кнопка хуже ожидания с честной подписью). Пока ждём — на экране
    // полный список файлов с процентами.
    if (decideSave(summarizeDraftMedia(getDraftMediaSnapshot()), opts) === "wait") {
      showedProgress = true;
      setWaitingUploads(true);
      setFinishing({ phase: "uploading" });
      const waited = await waitForDraftUploads({ signal: abort.signal });
      // Мастер закрыли (жест «назад», выход) — ничего больше не делаем.
      if (waited.aborted || !mountedRef.current) return;
      setWaitingUploads(false);
    }

    const decision = decideSave(summarizeDraftMedia(getDraftMediaSnapshot()), opts);
    if (decision !== "proceed") {
      // Часть файлов не доехала (или вышел потолок ожидания): объект не создаём.
      setFinishing(null);
      setUploadProblem({ timedOut: decision === "wait" });
      return;
    }

    try {
      // Finish the ordered field writer before transferring this exact draft.
      if (!pendingCreateBody.current) await autosave.flush();
    } catch (error) {
      setFinishing(null);
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить черновик. Повторите попытку");
      return;
    }
    if (!mountedRef.current) return;
    setSaving(true);
    if (showedProgress) setFinishing({ phase: "creating" });
    try {
      const body = pendingCreateBody.current ?? buildCreateBody(values);
      if (!pendingCreateBody.current) {
        const session = getPropertyDraftSession();
        if (session?.draft) {
          body.draftId = session.draft.id;
          body.draftRevision = session.draft.revision;
        }
      }
      // Порядок фото при создании из черновика решает сервер (order в
      // PropertyDraftMedia, см. draftAttach.ts) — без этого ключа обложкой
      // навсегда остался бы первый ЗАГРУЖЕННЫЙ снимок, а не выбранный агентом.
      if (!pendingCreateBody.current && coverUploadKey) body.coverUploadKey = coverUploadKey;
      pendingCreateBody.current = body;
      const completedDraftId = typeof body.draftId === "string" ? body.draftId : null;
      const saved = await create.mutateAsync(body);
      invalidatePropertyDraftSession();
      autosave.cancel();
      setCreated(true);

      // Сервер сообщает, сколько файлов не дошло до карточки (ответ POST
      // /properties с `media: { attached, skipped }`); пока поля нет — молчим.
      const skipped = skippedMediaCount(saved);
      if (skipped > 0) toast.error(skippedMediaMessage(skipped));

      // Черновик сервер удалил сам вместе с переносом файлов; здесь убираем
      // только запасную копию в браузере и плитки текущего мастера.
      if (draftKey) clearFormDraft(draftKey);
      draftIdRef.current = null;
      setDraftReminder(false);
      // Баннер черновика на списке объектов держит свою копию того же
      // запроса — без инвалидации он молчал бы про уже перенесённый черновик
      // до истечения staleTime и показывал бы карточку, которой больше нет.
      qc.invalidateQueries({ queryKey: PROPERTY_DRAFT_QUERY_KEY });
      if (!mountedRef.current) {
        clearDraftMedia({ draftId: completedDraftId });
        return;
      }
      if (showedProgress) {
        // Агент видел процесс — держим экран с итогом «Загружено X из Y»; плитки
        // чистятся и переход к карточке — по «Готово» (finishAndOpen).
        setFinishing({ phase: "done", shortId: saved.shortId });
        return;
      }
      clearDraftMedia({ draftId: completedDraftId });
      navigate(`/properties/${saved.shortId}`);
    } catch (err) {
      // A lost POST response may mean the draft was already transferred. Retry
      // the frozen request/key before attempting any new draft write.
      const stillRunning = err instanceof ApiError && err.data && typeof err.data === "object" && "inProgress" in err.data && err.data.inProgress === true;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && !stillRunning) pendingCreateBody.current = null;
      setFinishing(null);
      // 409 от DuplicatePropertyError несёт shortId уже существующей карточки —
      // настоящее совпадение по адресу+площади, а не догадка. Показываем его
      // на шаге проверки блоком `.dup` (см. комментарий в StepReview.tsx).
      if (err instanceof ApiError && err.status === 409 && typeof err.data === "object" && err.data && "existingShortId" in err.data) {
        const data = err.data as { existingShortId: number };
        setDuplicate({ shortId: data.existingShortId, message: err.message });
      }
      setSaveError(
        err instanceof ApiError
          ? err.message
          : // Сервер мог успеть создать объект — повтор с тем же ключом дубля не
            // даст (hooks/useRetryKey.ts), поэтому смело зовём нажать ещё раз.
            "Связь прервалась до ответа. Нажмите «Сохранить» ещё раз — второй объект не создастся"
      );
      setStep(WIZARD_STEPS.length - 1);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Раскладывает предложенный черновик поверх формы — вызывается и гейтом
   * (DraftGate.tsx::onGoTo — кнопкой «Продолжить» и кликом по строке сводки,
   * оба уже решили конкретный шаг), и автоматически (autoContinueDraft/
   * hasLiveDraftMedia), до того как агент вообще увидел вопрос.
   *
   * `targetStep` — куда встать ПОСЛЕ раскладки. Без него (только автопути
   * выше) поведение прежнее: сохранённый шаг черновика (или 0 у локальной
   * копии, где своего шага нет).
   */
  function applyOffer(o: OfferedDraft, targetStep?: number) {
    setOffered(null);
    setAutosaveArmed(true);
    if (o.source === "local") {
      // Раскладываем поверх пустого набора, а не вместо него: черновик мог быть
      // записан старой сборкой, где поля ещё не было.
      setValues(withPendingPin({ ...EMPTY_WIZARD_VALUES, ...o.values }));
      if (targetStep !== undefined) setStep(targetStep);
      return;
    }
    setValues(withPendingPin({ ...EMPTY_WIZARD_VALUES, ...(o.draft.values as Partial<WizardValues>) }));
    setStep(targetStep ?? Math.min(o.draft.step, WIZARD_STEPS.length - 1));
    void hydrateDraftMedia(o.draft.media, o.draft.id);
  }

  /** Гейт (DraftGate.tsx) уже решил, на какой шаг вести — «Продолжить» на
   *  первый незаполненный обязательный (firstIncompleteStep), клик по строке
   *  сводки — на шаг именно этого поля. */
  function goToDraftStep(step: number) {
    if (offered) applyOffer(offered, step);
  }

  /**
   * «Начать заново» — черновик и уже отданные файлы удаляются на сервере
   * безвозвратно, поэтому кнопка блокирующего гейта (DraftGate ниже) сначала
   * открывает ConfirmDialog и зовёт эту функцию только после «Начать заново»
   * во всплывшем окне (владелец 21.09.2026: «начать новый — удаляет черновик
   * после подтверждения»).
   */
  async function restartDraft(exit = false) {
    if (sellerImportLocked.current) return;
    if (restartState.pending) return;
    setRestartState({ pending: true, error: null });
    const wasArmed = autosaveArmed;
    setAutosaveArmed(false);
    autosave.cancel();
    let discardedDraftId = draftIdRef.current;
    // Сначала DELETE, потом всё остальное (WEB-05): пока старый черновик жив,
    // автосохранение не включаем, иначе его PUT вернёт старый черновик вместе с
    // фото прежнего объекта. Отказ показывается в гейте, гейт остаётся для повтора.
    const ok = await runRestartDraft(offered?.source, {
      // Файлы старого черновика удаляет сервер — иначе они остались бы на диске
      // до истечения срока, а агент считает, что начал с чистого листа.
      deleteServerDraft: async () => {
        // A failed initial GET does not prove that the server has no draft.
        const session = getPropertyDraftSession() ?? await loadPropertyDraftSession();
        if (!session.draft) { invalidatePropertyDraftSession(session); return; }
        discardedDraftId = session.draft.id;
        const deleted = await api<PropertyDraftSession>("/properties/drafts/current", {
          method: "DELETE", body: { draftId: session.draft.id, revision: session.draft.revision },
        });
        invalidatePropertyDraftSession(deleted);
      },
      commit: () => {
        setOffered(null);
        if (draftKey) clearFormDraft(draftKey);
        clearDraftMedia({ draftId: discardedDraftId });
        setDraftReminder(false);
        draftIdRef.current = null;
        setValues({ ...EMPTY_WIZARD_VALUES, intakeAgentId: initialIntakeAgentId ?? "" });
        setStep(0);
        setErrors({});
        setAutosaveArmed(!exit);
        if (exit) { setDraftChecked(false); onClose(); }
      },
      fail: (error) => setRestartState({ pending: false, error }),
    });
    if (!ok) { setAutosaveArmed(wasArmed); return; }
    setRestartState({ pending: false, error: null });
    qc.invalidateQueries({ queryKey: PROPERTY_DRAFT_QUERY_KEY });
  }

  async function retryDraftSave() {
    if (autosave.status.state !== "error") { autosave.retry(); return; }
    // Conflict recovery is explicit: never automatically replace another tab's
    // newer version, and keep this device's backup until the user chooses.
    try {
      const session = await loadPropertyDraftSession();
      autosave.cancel();
      setAutosaveArmed(false);
      if (session.draft) {
        setOffered({ source: "server", draft: session.draft,
          notice: "Черновик изменён на другом устройстве. Здесь показана версия сервера. Ваши изменения пока сохранены на этом устройстве; «Продолжить» откроет версию сервера." });
      } else {
        setSaveError("Этот черновик уже удалён или перенесён в объект. Удалите местный черновик, чтобы начать новый.");
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не удалось проверить черновик");
    }
  }

  /**
   * ВХОД `?fromClient=<clientId>` (21.09.2026) — заводит серверный черновик из
   * фактов и фото переписки продавца и раскладывает его поверх формы, минуя
   * DraftGate целиком (см. useServerDraft.onLoaded/onFailed выше). Единственный
   * возможный вопрос — «Заменить N загруженных фото?» — задаёт сервер ответом
   * 409 (D14, 02.10.2026); тогда функция зовётся второй раз уже с ответом
   * агента в `media`.
   *
   * ОШИБКА/НЕТ СЕТИ — МОЛЧА (владелец: «без красных баннеров»): мастер
   * открывается с выбранным продавцом и пустыми полями, agent заполняет
   * руками, как обычно. setSaveError здесь нарочно не зовётся — это не отказ
   * СОХРАНИТЬ объект, а неудачная попытка его предзаполнить.
   */
  async function startFromClient(clientId: string, media?: "replace" | "keep", mode?: "replace") {
    // Пока ответ на POST .../from-client/:id в пути, шагов не показываем — тот
    // же случай, что и `draftChecked` ниже: мастер был бы живым, агент успел бы
    // начать заполнять, а пришедший ответ затёр бы набранное через setValues.
    setDraftChecked(false);
    const token = propertyDraftSessionToken();
    try {
      await autosave.flush();
      const session = await ensurePropertyDraftSession();
      const res = await api<{ draft: PropertyDraftView }>(`/properties/drafts/from-client/${clientId}`, {
        method: "POST",
        body: { draftId: session.id, revision: session.revision, ...(media ? { media } : {}), ...(mode ? { mode } : {}) },
      });
      if (!mountedRef.current || !isPropertyDraftSessionCurrent(token)) return;
      adoptPropertyDraftSession({ draft: res.draft, revision: res.draft.revision });
      // Местные плитки чистим только ПОСЛЕ ответа (D14, 02.10.2026): до него
      // сервер мог спросить «Заменить?», и фото агента должны остаться на
      // экране. «Оставить» — плитки не трогаем, сервер вернул те же файлы.
      if (draftKey) clearFormDraft(draftKey);
      if (media !== "keep") clearDraftMedia({ draftId: session.id });
      // Автосохранение — тоже только после ответа: пока висит вопрос
      // «Заменить?», пустая форма не должна перезаписать черновик агента.
      setAutosaveArmed(true);
      draftIdRef.current = res.draft.id;
      setValues(
        withPendingPin({ ...EMPTY_WIZARD_VALUES, ...(res.draft.values as Partial<WizardValues>), sellerClientId: clientId })
      );
      // НЕ res.draft.step (21.09.2026): сервер (routes/properties/drafts.ts,
      // POST .../from-client/:clientId) пишет туда буквальный 0 — это верно
      // подразумевало «Фото», пока «Фото» и было нулевым шагом. После переноса
      // «Продавца» на первое место 0 — это он, а продавец здесь уже известен
      // (это и есть смысл входа из чата). Мастер из чата всегда открывается на
      // «Фото» — по макету это первый экран, где агенту есть что проверить.
      setStep(stepIndexOf("media"));
      void hydrateDraftMedia(res.draft.media, res.draft.id);
      qc.invalidateQueries({ queryKey: PROPERTY_DRAFT_QUERY_KEY });
    } catch (err) {
      if (!mountedRef.current || !isPropertyDraftSessionCurrent(token)) return;
      if (err instanceof ApiError && err.status === 409 && err.data && typeof err.data === "object" && "code" in err.data && err.data.code === "DRAFT_REPLACE_CONFIRM" && "draft" in err.data) {
        const previous = err.data.draft as PropertyDraftView;
        adoptPropertyDraftSession({ draft: previous, revision: previous.revision });
        setClientDraftConflict({ clientId, draft: previous });
        return;
      }
      const conflict = draftMediaConflict(err);
      if (conflict) {
        setMediaConflict({ clientId, mode: "start", replaceValues: mode === "replace", ...conflict });
        return;
      }
      const previous = getPropertyDraftSession()?.draft;
      if (previous) setOffered({ source: "server", draft: recoverDraftValues(previous, draftKey ? loadFormDraftSnapshot<WizardValues>(draftKey, WIZARD_LOCAL_DRAFT_TTL_MS) : null) });
      else {
        setAutosaveArmed(true);
        setValues((v) => isWizardEmpty(v) ? { ...v, sellerClientId: clientId } : v);
      }
      setSaveError(err instanceof Error ? err.message : "Не удалось загрузить данные продавца. Ваши поля сохранены");
    } finally {
      if (mountedRef.current && isPropertyDraftSessionCurrent(token)) setDraftChecked(true);
    }
  }

  /**
   * ВЫБОР СУЩЕСТВУЮЩЕГО ПРОДАВЦА ВНУТРИ МАСТЕРА (StepSeller.tsx::onSellerPicked,
   * шаг «Продавец» теперь первый — WIZARD_STEPS). Тот же запрос, что и вход
   * `?fromClient=`, но результат накладывается НЕ ЗАТИРАЯ уже введённое агентом
   * (fillEmptyFromDraftValues — только пустые поля) и файлы ДОБАВЛЯЮТСЯ к уже
   * загруженным (hydrateDraftMedia — слияние по uploadKey, не замена, см.
   * lib/draftUploads.ts). Отказ — молча: агент просто заполняет сам дальше.
   */
  async function enrichFromExistingSeller(clientId: string, media?: "replace" | "keep") {
    if (sellerImportLocked.current || sellerSelectionRef.current !== clientId) return;
    sellerImportLocked.current = true;
    setSellerImportPending(true);
    const selectionGeneration = sellerSelectionGeneration.current;
    const token = propertyDraftSessionToken();
    const selectionCurrent = () => sellerSelectionRef.current === clientId && sellerSelectionGeneration.current === selectionGeneration;
    const importCurrent = () => mountedRef.current && isPropertyDraftSessionCurrent(token) && selectionCurrent();
    setAutosaveArmed(false);
    try {
      await autosave.flush();
      if (!importCurrent()) return;
      const session = await ensurePropertyDraftSession();
      if (!importCurrent()) return;
      const res = await api<{ draft: PropertyDraftView }>(`/properties/drafts/from-client/${clientId}`, {
        method: "POST",
        body: { draftId: session.id, revision: session.revision, mode: "merge", ...(media ? { media } : {}) },
      });
      if (!mountedRef.current || !isPropertyDraftSessionCurrent(token)) return;
      // The server may already have written. Keep its revision even if an
      // external lifecycle event invalidated the original selection.
      adoptPropertyDraftSession({ draft: res.draft, revision: res.draft.revision });
      if (!selectionCurrent()) return;
      draftIdRef.current = res.draft.id;
      setValues((v) => fillEmptyFromDraftValues(v, res.draft.values as Partial<WizardValues>));
      // «Заменить» — сервер удалил прежние файлы; местные плитки убираем, иначе
      // слияние по uploadKey оставило бы на экране то, чего уже нет.
      if (media === "replace") clearDraftMedia({ draftId: session.id });
      void hydrateDraftMedia(res.draft.media, res.draft.id);
    } catch (err) {
      if (!importCurrent()) return;
      const conflict = draftMediaConflict(err);
      if (conflict) {
        setMediaConflict({ clientId, mode: "enrich", ...conflict });
        return;
      }
      // Сеть/сервер не ответили — продавец уже выбран (onChange отработал
      // синхронно), агент просто дозаполняет карточку сам, как обычно.
    } finally {
      sellerImportLocked.current = false;
      if (mountedRef.current) setSellerImportPending(false);
      if (mountedRef.current && isPropertyDraftSessionCurrent(token)) setAutosaveArmed(true);
    }
  }

  const stepKey = WIZARD_STEPS[step].key;
  const busy = saving || waitingUploads || sellerImportPending;
  const stepStates = wizardProgress(values, mediaSummary, errors, requireIntakeAgent);

  // Закрыть вкладку, пока идёт сохранение или не все файлы на сервере, — со
  // стандартным подтверждением браузера (lib/workGuard.ts). Объект создан —
  // защита снимается. Хук стоит ДО ранних return'ов ниже.
  const guardActive = !created && (saving || waitingUploads || sellerImportPending || mediaSummary.pending > 0 || mediaSummary.failed > 0);
  useEffect(() => {
    if (!guardActive) return;
    return registerWork({ id: "property-wizard", label: sellerImportPending ? "Получение данных продавца" : "Новый объект: файлы ещё не загружены", blocksUnload: true });
  }, [guardActive, sellerImportPending]);

  /** «Готово» на финальном экране: плитки чистим и открываем созданный объект. */
  function finishAndOpen() {
    const shortId = finishing?.shortId;
    const draftId = pendingCreateBody.current?.draftId;
    clearDraftMedia({ draftId: typeof draftId === "string" ? draftId : null });
    if (shortId !== undefined) navigate(`/properties/${shortId}`);
  }

  /** Окно выбора: повторить упавшие и сохранить заново (дождавшись их). */
  function retryProblemFiles() {
    for (const item of mediaSummary.photos.concat(mediaSummary.videos)) {
      if (canRetryDraftItem(item)) retryDraftMedia(item.uploadKey);
    }
    setUploadProblem(null);
    void save();
  }

  /** Окно выбора: убрать упавшие/потерянные и остаться на проверке. */
  function removeProblemFiles() {
    for (const item of mediaSummary.photos.concat(mediaSummary.videos)) {
      if (item.status === "failed" || item.status === "lost") void removeDraftMedia(item.uploadKey);
    }
    setUploadProblem(null);
  }

  // ЕДИНСТВЕННЫЙ ВОПРОС ПРИ ВХОДЕ `?fromClient=` (см. startFromClient выше):
  // у агента уже лежит СВОЙ черновик с файлами. Тот же приём, что у DraftGate
  // ниже — блокирует всё дерево целиком, пока агент не ответил.
  if (clientDraftConflict) {
    const { clientId, draft } = clientDraftConflict;
    return <ConfirmDialog
      title="Заменить заполненный черновик?"
      description="У вас уже есть незавершённый объект. Загрузка данных другого продавца заменит его поля."
      confirmLabel="Заменить черновик"
      cancelLabel="Оставить мой черновик"
      onConfirm={() => { setClientDraftConflict(null); void startFromClient(clientId, undefined, "replace"); }}
      onCancel={() => { setClientDraftConflict(null); applyOffer({ source: "server", draft }); }}
    />;
  }
  if (mediaConflict) {
    const answer = (media: "replace" | "keep") => {
      const { clientId, mode, replaceValues } = mediaConflict;
      setMediaConflict(null);
      if (mode === "start") void startFromClient(clientId, media, replaceValues ? "replace" : undefined);
      else void enrichFromExistingSeller(clientId, media);
    };
    return (
      <ConfirmDialog
        title={draftMediaConflictTitle(mediaConflict.photoCount, mediaConflict.videoCount)}
        description="Да — ваши файлы удалятся, вместо них встанут фото, которые продавец прислал в переписке. Нет — ваши файлы останутся, фото из переписки не добавятся."
        confirmLabel="Да, заменить"
        cancelLabel="Нет, оставить мои"
        onConfirm={() => answer("replace")}
        onCancel={() => answer("keep")}
      />
    );
  }

  // ГЕЙТ БЛОКИРУЕТ ВСЁ ДЕРЕВО ШАГОВ, ПОКА АГЕНТ НЕ ОТВЕТИЛ (см. докблок компонента
  // выше). Ни один шаг, ни кнопка добавления файла здесь не существуют — это и
  // чинит баг «файлы можно добавлять, пока автосохранение ещё выключено»: раз
  // степов нет, добавить файл неоткуда.
  // Ответ про черновик ещё в пути — шагов не рисуем вовсе (см. `draftChecked`).
  if (agentId && !draftChecked) {
    return (
      <div className="rh2">
        <div className="wiz">
          <div className="whead">
            <div className="line1">
              <div style={{ minWidth: 0 }}>
                <div className="ttl" role="heading" aria-level={1}>
                  Новый объект
                </div>
              </div>
              <button
                type="button"
                className="xbtn"
                onClick={onClose}
                aria-label="Закрыть мастер"
                data-testid="wizard-close"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="wbody">
            <div className="card tight">
              <div className="quiet" role="status" data-testid="wizard-draft-checking">
                <span className="dot" aria-hidden />
                <span className="txt">Смотрю, нет ли незаконченного объекта…</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (offered) {
    return (
      <DraftGate
        offer={offered}
        districts={districts ?? []}
        requireIntakeAgent={requireIntakeAgent}
        onClose={onClose}
        onGoTo={goToDraftStep}
        onRestart={() => void restartDraft()}
        restartPending={restartState.pending}
        restartError={restartState.error}
      />
    );
  }

  return (
    <WizardShell
      stepIndex={step}
      onClose={() => { if (!sellerImportLocked.current) onClose(); }}
      onBack={step > 0 ? () => { if (!sellerImportLocked.current) setStep(step - 1); } : null}
      onNext={goNext}
      nextLabel={step === WIZARD_STEPS.length - 1 ? "Сохранить" : "Далее"}
      busy={busy}
      busyLabel={sellerImportPending ? "Загружаю данные продавца…" : waitingUploads ? "Дожидаюсь файлов…" : "Сохраняю…"}
      offSite={values.offSite}
      onOffSiteChange={(offSite) => { if (!sellerImportLocked.current) patch({ offSite }); }}
      draftSaved={autosave.status.state === "server"}
      draftStatus={visibleDraftStatus}
      onRetryDraft={() => { if (!sellerImportLocked.current) void retryDraftSave(); }}
      onDeleteDraft={() => { if (!sellerImportLocked.current) setDeleteConfirmOpen(true); }}
      deleteDraftPending={restartState.pending}
      deleteDraftError={restartState.error}
      onGoToStep={(index: number) => {
        if (sellerImportLocked.current || busy || index < 0 || index >= WIZARD_STEPS.length) return;
        const currentErrors = validateStep(stepKey, values, { requireIntakeAgent });
        setErrors(currentErrors);
        setStep(index);
      }}
      stepStates={stepStates}
      onSaveAndExit={() => {
        if (sellerImportLocked.current) return;
        void autosave.flush().then(onClose).catch((error: unknown) => {
          setSaveError(error instanceof Error ? error.message : "Не удалось сохранить черновик");
        });
      }}
      closeDisabled={!canCloseWizard({ saving: busy, finishing: finishing !== null })}
      overlay={
        deleteConfirmOpen ? (
          <ConfirmDialog
            title="Удалить черновик?"
            description="Поля черновика и его фото и видео будут удалены. Восстановить их будет нельзя."
            confirmLabel="Удалить черновик"
            onConfirm={() => { setDeleteConfirmOpen(false); void restartDraft(true); }}
            onCancel={() => setDeleteConfirmOpen(false)}
          />
        ) : finishing ? (
          <SaveProgressOverlay items={media} phase={finishing.phase} onDone={finishAndOpen} />
        ) : uploadProblem ? (
          <UploadProblemSheet
            problems={media.filter((i) => i.status === "failed" || i.status === "lost")}
            timedOut={uploadProblem.timedOut}
            onRetry={retryProblemFiles}
            onGoToFiles={() => {
              setUploadProblem(null);
              setStep(stepIndexOf("media"));
            }}
            onRemove={removeProblemFiles}
            onSaveWithout={() => void save({ acceptedLoss: true })}
          />
        ) : null
      }
    >
      {saveError && (
        <div className="card tight">
          <div className="quiet crit" role="alert" data-testid="wizard-save-error">
            <span className="dot crit" aria-hidden />
            <span className="txt">{saveError}</span>
          </div>
        </div>
      )}

      {stepKey === "seller" && (
        <>
        {sellerImportPending && <div className="quiet" role="status" data-testid="wizard-seller-import-pending">Загружаю данные продавца. После загрузки его можно сменить.</div>}
        <fieldset disabled={sellerImportPending} aria-busy={sellerImportPending || undefined}
          style={{ display: "flex", flexDirection: "column", gap: "inherit", padding: 0, margin: 0, border: 0, minWidth: 0 }}>
        <StepSeller
          values={values}
          errors={errors}
          requireIntakeAgent={requireIntakeAgent}
          onChange={patchSeller}
          onSellerPicked={(clientId) => void enrichFromExistingSeller(clientId)}
        />
        </fieldset>
        </>
      )}
      {stepKey === "media" && (
        <StepMedia
          photos={mediaSummary.photos}
          videos={mediaSummary.videos}
          coverUploadKey={coverUploadKey}
          onSetCover={setManualCoverKey}
          offSite={values.offSite ?? false}
        />
      )}
      {stepKey === "main" && <StepMain values={values} errors={errors} onChange={patch} />}
      {stepKey === "place" && (
        <StepPlace
          values={values}
          errors={errors}
          districts={districts ?? []}
          districtsLoading={districtsLoading}
          onChange={patch}
          mapNote={photoSnapNote}
        />
      )}
      {stepKey === "review" && (
        <StepReview
          values={values}
          districts={districts ?? []}
          media={mediaSummary}
          errors={errors}
          onGoTo={setStep}
          duplicate={duplicate}
        />
      )}
    </WizardShell>
  );
}

/**
 * Чтение черновика с сервера ровно один раз за открытие мастера. Перечитывать
 * его нельзя: предложение «продолжить» поверх того, что агент только что набрал
 * сам, — это потеря работы, а не помощь.
 */
function useServerDraft({
  enabled,
  onLoaded,
  onFailed,
}: {
  enabled: boolean;
  onLoaded: (draft: PropertyDraftView | null) => void;
  onFailed: () => void;
}): void {
  const done = useRef(false);
  const active = useRef(true);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  /**
   * Флага «запрос отменён» здесь НАРОЧНО нет. В React 18 StrictMode эффект на
   * монтировании прогоняется дважды (смонтировали → размонтировали →
   * смонтировали), и связка «однажды + отменено при уборке» давала ровно то,
   * чего быть не должно: первый прогон запрос отправлял, уборка его ответ
   * выбрасывала, а второй прогон упирался в «уже спрашивали» и не отправлял
   * ничего. Итог — черновик не предлагался и автосохранение не включалось
   * вовсе. Поймано кадрами: после перезаполнения и перезагрузки мастер
   * открывался пустым.
   *
   * Состояние при двойном прогоне то же самое (StrictMode пересоздаёт эффекты,
   * а не компонент), поэтому ответ первого запроса приходит ровно туда, куда
   * надо, и отменять его незачем.
   */
  useEffect(() => {
    active.current = true;
    if (!enabled || done.current) return () => { active.current = false; };
    done.current = true;
    const token = propertyDraftSessionToken();
    loadPropertyDraftSession()
      .then((res) => {
        if (!active.current || !isPropertyDraftSessionCurrent(token)) return;
        const draft = res.draft;
        // Пустой черновик без файлов предлагать не за чем — он ничего не хранит.
        const worth = draft && (draft.media.length > 0 || Object.keys(draft.values ?? {}).length > 0);
        onLoadedRef.current(worth ? draft : null);
      })
      .catch(() => {
        if (active.current && isPropertyDraftSessionCurrent(token)) onFailedRef.current();
      });
    return () => { active.current = false; };
  }, [enabled]);
}

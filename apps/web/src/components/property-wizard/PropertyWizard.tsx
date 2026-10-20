import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRetryKey } from "../../hooks/useRetryKey";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { PropertyDraftView } from "@royal-home/shared";
import { useDistricts } from "../../hooks/useDistricts";
import { useCreateProperty } from "../../hooks/useProperties";
import { PROPERTY_DRAFT_QUERY_KEY } from "../../hooks/usePropertyDraft";
import { clearFormDraft, loadFormDraft } from "../../hooks/useFormDraft";
import { useWizardLocalDraft } from "./useWizardLocalDraft";
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
  // Руководитель обязан указать интейкера явно; рядовому агенту сервер
  // подставляет его самого (routes/properties/crud.ts).
  const requireIntakeAgent = can("properties.editForeign");

  const [values, setValues] = useState<WizardValues>(() => ({
    ...EMPTY_WIZARD_VALUES,
    intakeAgentId: initialIntakeAgentId ?? "",
  }));
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
  const [draftSaved, setDraftSaved] = useState(false);

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
        // «Продолжить» уже нажали на баннере списка объектов, или в очереди
        // уже едут/лежат плитки прошлого захода (мастер закрывали, не
        // дождавшись отдачи) — решение известно, спрашивать не за чем.
        if (autoContinueDraft || hasLiveDraftMedia()) {
          applyOffer({ source: "server", draft });
          return;
        }
        setOffered({ source: "server", draft });
        return;
      }
      // Сервер черновика не знает — смотрим запасную копию в браузере.
      const local = draftKey ? loadFormDraft<WizardValues>(draftKey) : null;
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
      const local = draftKey ? loadFormDraft<WizardValues>(draftKey) : null;
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
  useWizardLocalDraft(draftKey, autosaveArmed, values);
  // created: объект уже создан — черновик больше не пишем вовсе. Иначе
  // досылка при уходе со страницы заводила черновик заново из данных только
  // что созданного объекта, и баннер предлагал «продолжить» — путь к дублю.
  const [created, setCreated] = useState(false);
  useServerAutosave(autosaveArmed && !saving && !created, values, step, draftIdRef, setDraftSaved);

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
    const stepErrors = validateStep(WIZARD_STEPS[step].key, values, { requireIntakeAgent });
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
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
    if (savingRef.current) return;
    const all = validateAll(values, { requireIntakeAgent });
    setErrors(all);
    if (Object.keys(all).length > 0) return;

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

    setSaving(true);
    if (showedProgress) setFinishing({ phase: "creating" });
    try {
      const body = buildCreateBody(values);
      if (draftIdRef.current) body.draftId = draftIdRef.current;
      // Порядок фото при создании из черновика решает сервер (order в
      // PropertyDraftMedia, см. draftAttach.ts) — без этого ключа обложкой
      // навсегда остался бы первый ЗАГРУЖЕННЫЙ снимок, а не выбранный агентом.
      if (coverUploadKey) body.coverUploadKey = coverUploadKey;
      const saved = await create.mutateAsync(body);
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
        clearDraftMedia();
        return;
      }
      if (showedProgress) {
        // Агент видел процесс — держим экран с итогом «Загружено X из Y»; плитки
        // чистятся и переход к карточке — по «Готово» (finishAndOpen).
        setFinishing({ phase: "done", shortId: saved.shortId });
        return;
      }
      clearDraftMedia();
      navigate(`/properties/${saved.shortId}`);
    } catch (err) {
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
    hydrateDraftMedia(o.draft.media);
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
  async function restartDraft() {
    if (restartState.pending) return;
    setRestartState({ pending: true, error: null });
    // Сначала DELETE, потом всё остальное (WEB-05): пока старый черновик жив,
    // автосохранение не включаем, иначе его PUT вернёт старый черновик вместе с
    // фото прежнего объекта. Отказ показывается в гейте, гейт остаётся для повтора.
    const ok = await runRestartDraft(offered?.source, {
      // Файлы старого черновика удаляет сервер — иначе они остались бы на диске
      // до истечения срока, а агент считает, что начал с чистого листа.
      deleteServerDraft: () => api("/properties/drafts/current", { method: "DELETE" }),
      commit: () => {
        setOffered(null);
        if (draftKey) clearFormDraft(draftKey);
        clearDraftMedia();
        setDraftReminder(false);
        draftIdRef.current = null;
        setAutosaveArmed(true);
      },
      fail: (error) => setRestartState({ pending: false, error }),
    });
    if (!ok) return;
    setRestartState({ pending: false, error: null });
    qc.invalidateQueries({ queryKey: PROPERTY_DRAFT_QUERY_KEY });
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
  async function startFromClient(clientId: string, media?: "replace" | "keep") {
    // Пока ответ на POST .../from-client/:id в пути, шагов не показываем — тот
    // же случай, что и `draftChecked` ниже: мастер был бы живым, агент успел бы
    // начать заполнять, а пришедший ответ затёр бы набранное через setValues.
    setDraftChecked(false);
    try {
      const res = await api<{ draft: PropertyDraftView }>(`/properties/drafts/from-client/${clientId}`, {
        method: "POST",
        ...(media ? { body: { media } } : {}),
      });
      // Местные плитки чистим только ПОСЛЕ ответа (D14, 02.10.2026): до него
      // сервер мог спросить «Заменить?», и фото агента должны остаться на
      // экране. «Оставить» — плитки не трогаем, сервер вернул те же файлы.
      if (draftKey) clearFormDraft(draftKey);
      if (media !== "keep") clearDraftMedia();
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
      void hydrateDraftMedia(res.draft.media);
      qc.invalidateQueries({ queryKey: PROPERTY_DRAFT_QUERY_KEY });
    } catch (err) {
      const conflict = draftMediaConflict(err);
      if (conflict) {
        setMediaConflict({ clientId, mode: "start", ...conflict });
        return;
      }
      setAutosaveArmed(true);
      setValues({ ...EMPTY_WIZARD_VALUES, sellerClientId: clientId });
    } finally {
      setDraftChecked(true);
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
    try {
      const res = await api<{ draft: PropertyDraftView }>(`/properties/drafts/from-client/${clientId}`, {
        method: "POST",
        ...(media ? { body: { media } } : {}),
      });
      draftIdRef.current = res.draft.id;
      setValues((v) => fillEmptyFromDraftValues(v, res.draft.values as Partial<WizardValues>));
      // «Заменить» — сервер удалил прежние файлы; местные плитки убираем, иначе
      // слияние по uploadKey оставило бы на экране то, чего уже нет.
      if (media === "replace") clearDraftMedia();
      void hydrateDraftMedia(res.draft.media);
    } catch (err) {
      const conflict = draftMediaConflict(err);
      if (conflict) {
        setMediaConflict({ clientId, mode: "enrich", ...conflict });
        return;
      }
      // Сеть/сервер не ответили — продавец уже выбран (onChange отработал
      // синхронно), агент просто дозаполняет карточку сам, как обычно.
    }
  }

  const stepKey = WIZARD_STEPS[step].key;
  const busy = saving || waitingUploads;

  // Закрыть вкладку, пока идёт сохранение или не все файлы на сервере, — со
  // стандартным подтверждением браузера (lib/workGuard.ts). Объект создан —
  // защита снимается. Хук стоит ДО ранних return'ов ниже.
  const guardActive = !created && (saving || waitingUploads || mediaSummary.pending > 0 || mediaSummary.failed > 0);
  useEffect(() => {
    if (!guardActive) return;
    return registerWork({ id: "property-wizard", label: "Новый объект: файлы ещё не загружены", blocksUnload: true });
  }, [guardActive]);

  /** «Готово» на финальном экране: плитки чистим и открываем созданный объект. */
  function finishAndOpen() {
    const shortId = finishing?.shortId;
    clearDraftMedia();
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
  if (mediaConflict) {
    const answer = (media: "replace" | "keep") => {
      const { clientId, mode } = mediaConflict;
      setMediaConflict(null);
      if (mode === "start") void startFromClient(clientId, media);
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
      onClose={onClose}
      onBack={step > 0 ? () => setStep(step - 1) : null}
      onNext={goNext}
      nextLabel={step === WIZARD_STEPS.length - 1 ? "Сохранить" : "Далее"}
      busy={busy}
      busyLabel={waitingUploads ? "Дожидаюсь файлов…" : "Сохраняю…"}
      offSite={values.offSite}
      onOffSiteChange={(offSite) => patch({ offSite })}
      draftSaved={draftSaved}
      closeDisabled={!canCloseWizard({ saving: busy, finishing: finishing !== null })}
      overlay={
        finishing ? (
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
        <StepSeller
          values={values}
          errors={errors}
          requireIntakeAgent={requireIntakeAgent}
          onChange={patch}
          onSellerPicked={(clientId) => void enrichFromExistingSeller(clientId)}
        />
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
    if (!enabled || done.current) return;
    done.current = true;
    api<{ draft: PropertyDraftView | null }>("/properties/drafts/current")
      .then((res) => {
        const draft = res.draft;
        // Пустой черновик без файлов предлагать не за чем — он ничего не хранит.
        const worth = draft && (draft.media.length > 0 || Object.keys(draft.values ?? {}).length > 0);
        onLoadedRef.current(worth ? draft : null);
      })
      .catch(() => onFailedRef.current());
  }, [enabled]);
}

/** Автосохранение полей — с задержкой, чтобы не слать запрос на каждый символ.
 *  22.09.2026: было 2.5с (шторм 429 — общий лимитер считал вкладку из
 *  нескольких запросов подряд); 6с реже шлёт запрос, но само по себе
 *  увеличивает окно, где несохранённые правки живут только в памяти —
 *  поэтому смена шага и размонтирование ниже принудительно досылают то,
 *  что ещё не уехало, а не ждут оставшийся дебаунс. */
const AUTOSAVE_DELAY_MS = 6_000;

function useServerAutosave(
  enabled: boolean,
  values: WizardValues,
  step: number,
  draftIdRef: React.MutableRefObject<string | null>,
  onSaved?: (saved: boolean) => void
): void {
  const latestRef = useRef({ values, step });
  const dirtyRef = useRef(false);
  const prevStepRef = useRef(step);
  // Пока есть несохранённые поля, автосохранение стоит в реестре работы
  // (lib/workGuard.ts): уход вкладки в фон/закрытие (hidden/pagehide) досылает
  // их запросом с keepalive, а автообновление не перезагружает страницу
  // посреди правки. blocksUnload нет — окно подтверждения здесь не нужно.
  const unregisterRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    latestRef.current = { values, step };
  }, [values, step]);

  const markClean = useCallback(() => {
    dirtyRef.current = false;
    unregisterRef.current?.();
    unregisterRef.current = null;
  }, []);

  const flush = useCallback((keepalive = false) => {
    if (!dirtyRef.current) return;
    const { values: pendingValues, step: pendingStep } = latestRef.current;
    if (isWizardEmpty(pendingValues)) return;
    markClean();
    void api<{ draft: PropertyDraftView }>("/properties/drafts/current", {
      method: "PUT",
      body: { values: toDraftValues(pendingValues), step: pendingStep },
      ...(keepalive ? { keepalive: true } : {}),
    })
      .then((res) => {
        draftIdRef.current = res.draft.id;
        setDraftReminder(true);
        onSaved?.(true);
      })
      // Молча: связь в подъездах рвётся постоянно, и жаловаться на каждую
      // неудачную автозапись значило бы мешать работать. Запасная копия в
      // localStorage при этом пишется своим путём и не зависит от сети.
      // Строка «Черновик сохранён» просто не загорается — это и есть честно.
      .catch(() => undefined);
  }, [draftIdRef, onSaved, markClean]);

  useEffect(() => {
    if (!enabled) {
      // Идёт сохранение объекта или он уже создан: недосланная правка черновика
      // больше не нужна, и досылка при размонтировании не должна её отправить.
      markClean();
      return;
    }
    if (isWizardEmpty(values)) return;
    // Новый ввод пошёл — предыдущая надпись «Черновик сохранён» относится уже
    // не к текущему состоянию полей, гасим её до ответа сервера.
    onSaved?.(false);
    dirtyRef.current = true;
    if (!unregisterRef.current) {
      unregisterRef.current = registerWork({
        id: "wizard-draft-autosave",
        label: "Черновик объекта: поля ещё не сохранены",
        blocksUnload: false,
        flush: () => flush(true),
      });
    }

    // Шаг сменился (агент нажал «Далее»/«Назад») — не ждём оставшийся
    // дебаунс, шлём то, что накопилось, сразу: иначе уход со страницы за
    // < 6с после последней правки терял бы эту правку молча.
    if (prevStepRef.current !== step) {
      prevStepRef.current = step;
      flush();
      return;
    }
    prevStepRef.current = step;

    const timer = setTimeout(flush, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, values, step, flush, onSaved, markClean]);

  // Размонтирование мастера (закрыли модалку/ушли с экрана) с ещё не
  // отправленной правкой — досылаем её, а не бросаем дебаунс-таймер.
  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);
}

/** Черновик хранит поля как есть (строками) — приведение к числам делает только
 *  buildCreateBody в момент отправки. Схема на сервере — propertyDraftSaveSchema. */
function toDraftValues(v: WizardValues): Record<string, unknown> {
  return { ...v };
}

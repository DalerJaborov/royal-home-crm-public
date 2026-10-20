import { useIsReadOnly } from "../lib/permissions";
import { CleanRecordForm, ReadOnlyRecordFields, CleanInteractionContext } from "./clean/CleanRecordForm";
import { useCleanShell } from "../hooks/useCleanShell";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { useAddInteraction, useUpdateClient, useClient } from "../hooks/useClients";
import { useParseNote } from "../hooks/useAi";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useDistricts } from "../hooks/useDistricts";
import { useProperties, useProperty } from "../hooks/useProperties";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { CALL_OUTCOME_CHOICES, SELLER_CALL_OUTCOME_CHOICES, type InteractionOutcome } from "@royal-home/shared";
import { INTERACTION_OUTCOME_LABELS, INTERACTION_TYPE_LABELS, formatPropertyCode } from "../lib/clientFormat";
import { ConfirmDialog } from "./ConfirmDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { dushanbeInputToIso, dushanbeTodayKey } from "../lib/date";
import { parseResultPatch } from "../lib/addInteractionParse";
import { buildAiClientPatch, saveInteractionWithCard, type AiClientUpdates } from "../lib/addInteractionSave";
import { useDraftBeforeUpdate } from "../hooks/useDraftBeforeUpdate";

// Только звонок и показ: «сообщение» и «встреча» из формы убраны — переписка живёт в
// разделе «Сообщения», а встреча по смыслу и есть показ. Записи прежних типов остаются
// в базе и в истории карточки, поэтому INTERACTION_TYPE_LABELS их по-прежнему знает.
const TYPES = ["CALL", "SHOWING"] as const;
// Исходы «итога звонка» — состояния ожидания вместо оценки настроения (решение
// владельца 30.07). Старые POSITIVE/NEUTRAL в выборе не показываем, но записи с
// ними остаются в истории и подписи для них есть.
const OUTCOMES = CALL_OUTCOME_CHOICES;
// У продавца есть пятый исход — «Объект принят в работу», запускающий 36-часовой
// таймер «Итог объекта». Для покупателя он бессмысленен — там нет объекта в работе.
const SELLER_OUTCOMES = SELLER_CALL_OUTCOME_CHOICES;

/**
 * Выбор показанного объекта поиском (05.10.2026). Раньше был `<select>` с первыми
 * 20 свободными объектами: любого другого в форме просто не существовало. Теперь
 * поле ввода ходит в `GET /properties?q=` (номер «ОБ-000088», «88», слова) с
 * дебаунсом; уже выбранный объект (в том числе пришедший пропсом) всегда в списке —
 * его дозагружает `GET /properties/:id`, если поиск его не вернул.
 */
function ShowingPropertyPicker({
  value,
  onChange,
  allowEmpty,
}: {
  value: string;
  onChange: (id: string) => void;
  allowEmpty?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 250);
  // Без запроса — свободные (как раньше); с запросом статус не ограничиваем:
  // показать можно и объект, снятый с рекламы или в задатке. Удалённых сервер не отдаёт.
  const found = useProperties({ q: q || undefined, status: q ? undefined : "AVAILABLE", page: 1 });
  const items = found.data?.items ?? [];
  const selectedInList = items.find((p) => p.id === value);
  const selectedFetched = useProperty(value && !selectedInList ? value : undefined);
  const selected = selectedInList ?? selectedFetched.data;
  const options = selected && !selectedInList ? [selected, ...items] : items;

  return (
    <div className="fld">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Номер ОБ-…, название или адрес"
        aria-label="Поиск объекта"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size={Math.min(Math.max(options.length + (allowEmpty ? 1 : 0), 2), 6)}
        aria-label="Объект"
      >
        {allowEmpty && <option value="">не указывать</option>}
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {formatPropertyCode(p.shortId)} · {p.title}
          </option>
        ))}
      </select>
      {found.isLoading && <span className="msg">Ищу…</span>}
      {!found.isLoading && q && items.length === 0 && <span className="msg">Ничего не нашли.</span>}
    </div>
  );
}

type ClientUpdates = AiClientUpdates;

export function AddInteractionModal({
  clientId,
  selectedClientName,
  onClose,
  initialType,
  initialPropertyId,
  isSeller,
  onSaved,
}: {
  clientId: string;
  /** Display name from an already permission-filtered client selection. */
  selectedClientName?: string;
  onClose: () => void;
  /** Открыть форму сразу нужным типом — «Назначить показ» из окна подбора. */
  initialType?: (typeof TYPES)[number];
  /** Объект показа, выбранный до открытия формы. */
  initialPropertyId?: string;
  /** Client.kind === "SELLER" — открывает пятый исход «Объект принят в работу». */
  isSeller?: boolean;
  /** Взаимодействие успешно сохранено — родитель решает, что сделать с исходом
   *  (например, «Ждёт варианты» открывает переписку прямо на карточке). */
  onSaved?: (outcome: string | undefined) => void;
}) {
  const clean = useCleanShell();
  const accountReadOnly = useIsReadOnly();
  const readOnlyRef = useRef(accountReadOnly);
  readOnlyRef.current = accountReadOnly;
  const contextClient = useClient(clean && !selectedClientName ? clientId : undefined);
  /**
   * РЕЖИМ ПЛАНИРОВАНИЯ. «Назначить показ» из окна подбора — это будущее событие:
   * дата, время, объект. Раньше кнопка открывала этот же трёхшаговый мастер
   * «Что было → Как прошло → Что дальше», который спрашивает о ПРОШЕДШЕМ разговоре
   * («Какой объект показывали») — владелец 06.08.2026 наткнулся на это вживую:
   * «нажимаю назначить показ, а выходит окно как будто показ уже был».
   * В режиме планирования форма — один экран без разбора ИИ и без исходов.
   */
  const scheduling = initialType === "SHOWING" && !!initialPropertyId;
  const outcomeChoices = isSeller ? SELLER_OUTCOMES : OUTCOMES;
  const addInteraction = useAddInteraction(clientId);
  const updateClient = useUpdateClient(clientId);
  const parseNote = useParseNote();
  const { data: districts } = useDistricts();
  const [error, setError] = useState<string | null>(null);
  /** Взаимодействие уже записано, упал только второй шаг (правка карточки по
   *  подсказке ИИ) — повторное «Сохранить» дописывает только карточку (F4). */
  const [interactionSaved, setInteractionSaved] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [clientUpdates, setClientUpdates] = useState<ClientUpdates | null>(null);
  const [applyClientUpdates, setApplyClientUpdates] = useState(true);
  const [notes, setNotes] = useState("");
  /**
   * ВЗАИМОДЕЙСТВИЕ ЗАПОЛНЯЕТСЯ ШАГАМИ (просьба владельца).
   *
   * Одним экраном форма требовала решить всё сразу: что было, как прошло, что
   * дальше. Агент, только что положивший трубку, помнит разговор — но не помнит,
   * какой из восьми исходов выбрать, и заполнял первое попавшееся.
   *
   * Шаги ещё и следуют из того, как работает разбор: заметку разбирает ИИ, и тип,
   * исход и следующий шаг приходят на второй и третий шаг УЖЕ заполненными. То есть
   * агент не вводит их, а подтверждает — но только если первый шаг был отдельным.
   */
  const [step, setStep] = useState(1);
  const TOTAL_STEPS = scheduling ? 1 : 3;

  const speech = useSpeechRecognition((transcript) => {
    setNotes((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
  });
  const [type, setType] = useState<(typeof TYPES)[number]>(initialType ?? "CALL");
  // Объект показа. Список тянем только когда он реально нужен — при выборе «Показ».
  const [propertyId, setPropertyId] = useState(initialPropertyId ?? "");
  // Список объектов — в ShowingPropertyPicker (поиск), монтируется только для показа.
  // Тип шире, чем набор кнопок текущего клиента (OUTCOMES/SELLER_OUTCOMES не
  // пересекаются целиком с 28.08.2026 — у продавца больше нет «Ждёт показ»/«Ждёт
  // варианты»): состояние должно принимать значения обоих наборов.
  const [outcome, setOutcome] = useState<InteractionOutcome | "">("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionDate, setNextActionDate] = useState("");
  /** Время необязательно: «перезвонить в четверг» — нормальная задача без часа.
   *  Указано — придёт push за час до встречи; не указано — только вечерняя сводка. */
  const [nextActionTime, setNextActionTime] = useState("");
  useDraftBeforeUpdate(`interaction:${clientId}:${initialType ?? "CALL"}:${initialPropertyId ?? ""}`,
    { notes, nextAction, nextActionDate, nextActionTime, type, propertyId, outcome, step, aiNote, clientUpdates, applyClientUpdates, interactionSaved },
    (draft) => {
      if (!draft || typeof draft !== "object" || typeof draft.notes !== "string" || typeof draft.nextAction !== "string"
        || typeof draft.nextActionDate !== "string" || typeof draft.nextActionTime !== "string" || typeof draft.propertyId !== "string"
        || !TYPES.includes(draft.type) || !Number.isInteger(draft.step) || draft.step < 1 || draft.step > 3
        || (draft.outcome !== "" && !outcomeChoices.some((choice) => choice === draft.outcome))) return;
      setNotes(draft.notes); setNextAction(draft.nextAction); setNextActionDate(draft.nextActionDate); setNextActionTime(draft.nextActionTime);
      setType(draft.type); setPropertyId(draft.propertyId); setOutcome(draft.outcome); setStep(draft.step);
      if (typeof draft.aiNote === "string" || draft.aiNote === null) setAiNote(draft.aiNote);
      if (typeof draft.applyClientUpdates === "boolean") setApplyClientUpdates(draft.applyClientUpdates);
      // Preserve the completed first save when only the optional client patch failed:
      // retrying the restored form must not create a second interaction.
      if (typeof draft.interactionSaved === "boolean") setInteractionSaved(draft.interactionSaved);
      const updates = draft.clientUpdates;
      if (updates === null) setClientUpdates(null);
      else if (updates && typeof updates === "object" && !Array.isArray(updates)
        && Object.entries(updates).every(([key, value]) => value === null
          || (["budgetMin", "budgetMax", "desiredRooms"].includes(key) ? typeof value === "number" && Number.isFinite(value)
            : ["desiredDistrict", "requirementsNotes"].includes(key) && typeof value === "string"))) setClientUpdates(updates);
    },
    (draft) => !draft.notes.trim() && !draft.nextAction.trim() && !draft.nextActionDate && !draft.outcome && draft.propertyId === (initialPropertyId ?? ""));

  /**
   * Есть ли что терять при закрытии. Начальные значения приходят пропсами
   * (initialType/initialPropertyId), поэтому «грязным» считаем только то, что
   * человек набрал или выбрал сам сверх них.
   */
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty =
    notes.trim().length > 0 ||
    nextAction.trim().length > 0 ||
    nextActionDate.length > 0 ||
    outcome !== "" ||
    propertyId !== (initialPropertyId ?? "");
  function requestClose() {
    if (dirty) setConfirmClose(true);
    else onClose();
  }
  /** Ссылка на всегда свежую проверку «грязно ли» — окно закрывается из шапки,
   *  по Esc и смахиванием, и все три пути обязаны спросить об одном и том же. */
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  /**
   * Разбор запускается САМ, когда агент дописал заметку.
   *
   * Раньше это была кнопка «Разобрать (ИИ)», и работала она ровно тогда, когда про
   * неё вспоминали. Владелец 01.08.2026: «добавить взаимодействие слишком сложно и
   * долго заполнять, подключай ИИ, чтобы агент нажимал всего пару кликов».
   *
   * Защита от повтора — в parsedFor: ответ модели переписывает саму заметку
   * (result.interaction.notes), и без отметки «этот текст уже разбирали» разбор
   * вызывал бы сам себя по кругу, на каждый ответ. Порог в 15 знаков отсекает
   * «позвонил» — по такому тексту доставать нечего, а вызов стоит денег.
   */
  const debouncedNotes = useDebouncedValue(notes, 1200);
  const parsedFor = useRef<string | null>(null);
  // Свежий текст заметки для сверки после ответа ИИ (FORMS03) и признак «разбор идёт»:
  // parseNote.isPending в эффекте после устаревшего ответа ещё может быть true.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const parsingRef = useRef(false);
  // Растёт, когда ответ оказался устаревшим: эффект ниже разбирает заметку заново.
  const [parseTick, setParseTick] = useState(0);
  useEffect(() => {
    const text = debouncedNotes.trim();
    // В режиме планирования разбор не нужен: комментарий к будущему показу — не
    // рассказ о разговоре, доставать из него тип/исход нечего.
    if (scheduling) return;
    if (text.length < 15 || parsedFor.current === text || parsingRef.current) return;
    parsedFor.current = text;
    void handleParseAi();
    // handleParseAi намеренно не в зависимостях: он пересоздаётся на каждый рендер,
    // и добавление его сюда означало бы разбор на каждое нажатие клавиши.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedNotes, parseTick]);

  async function handleParseAi() {
    if (readOnlyRef.current) return;
    setError(null);
    setAiNote(null);
    setClientUpdates(null);
    const sent = notesRef.current;
    if (!sent.trim()) return;
    parsingRef.current = true;
    let stale = false;
    try {
      const result = await parseNote.mutateAsync({ text: sent, clientId });
      if (result.degraded) {
        setAiNote("ИИ недоступен, заполните поля вручную.");
        return;
      }
      // Пока ИИ считал, агент мог дописать заметку: ответ по старому тексту её не
      // затирает, а разбор запускается заново по свежему (FORMS03). Чужой тип
      // (MESSAGE/MEETING у необновлённой модели) отсеивает сама parseResultPatch.
      const patch = parseResultPatch(sent, notesRef.current, result.interaction, TYPES);
      if (!patch) {
        stale = true;
        parsedFor.current = null;
        return;
      }
      if (patch.type) setType(patch.type as (typeof TYPES)[number]);
      if (patch.outcome) setOutcome(patch.outcome as (typeof OUTCOMES)[number]);
      if (patch.notes) setNotes(patch.notes);
      if (patch.nextAction) setNextAction(patch.nextAction);
      if (patch.nextActionDate) setNextActionDate(patch.nextActionDate);
      const hasUpdates = Object.values(result.clientUpdates).some((v) => v !== undefined && v !== null);
      if (hasUpdates) setClientUpdates(result.clientUpdates);
      setAiNote("Поля предзаполнены (ИИ), проверьте перед сохранением.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось разобрать текст");
    } finally {
      parsingRef.current = false;
      if (stale) setParseTick((t) => t + 1);
    }
  }

  async function handleSubmit() {
    if (readOnlyRef.current) { setError("Доступ только для просмотра. Изменения не отправлены."); return; }
    // Enter в текстовом поле отправляет форму сам, без нажатия кнопки. На первом и
    // втором шаге это сохранило бы взаимодействие с половиной полей — поэтому
    // трактуем такой Enter как «Далее», а не как «Сохранить».
    if (step < TOTAL_STEPS) {
      if (step === 1 && !notes.trim()) return;
      setStep((s) => s + 1);
      return;
    }
    // Будущий показ без даты и времени — не показ, а пометка: календарь и
    // напоминания (за 2 часа и 40 минут) отсчитываются именно от них.
    if (scheduling && (!nextActionDate || !nextActionTime)) {
      setError("Укажите дату и время показа");
      return;
    }
    // «Ждёт показ» без даты и времени раньше сохранялся, но ничего не запускал —
    // ни календаря, ни напоминания за 2 часа/40 минут. Спецификация требует их
    // обязательными именно для этого исхода.
    if (outcome === "WAITING_SHOWING" && (!nextActionDate || !nextActionTime)) {
      setError("Для «Ждёт показ» укажите дату и время");
      setStep(3);
      return;
    }
    setError(null);
    // Правка карточки — только поля, которые сервер примет: ответ ИИ не
    // проверен схемой, и «комнат: 2.5» раньше валило весь второй шаг (F4).
    const cardPatch = applyClientUpdates && clientUpdates ? buildAiClientPatch(clientUpdates, districts) : {};
    let savedNow = interactionSaved;
    try {
      await saveInteractionWithCard({
        alreadySaved: interactionSaved,
        markSaved: () => {
          savedNow = true;
          setInteractionSaved(true);
        },
        saveInteraction: () =>
          addInteraction.mutateAsync({
            type,
            notes: scheduling && !notes.trim() ? "Назначен показ" : notes,
            // Без этого показ не засчитывается объекту вовсе — счётчик показов
            // на карточке объекта всегда оставался нулём.
            propertyId: type === "SHOWING" && propertyId ? propertyId : undefined,
            outcome: outcome || undefined,
            nextAction: nextAction || undefined,
            // Дата без времени уходит как есть — сервер трактует полночь как «на этот день»
            // и напоминает только вечерней сводкой. С временем шлём момент по Душанбе
            // (dushanbeInputToIso), из него же считается push «за час до встречи».
            // Раньше здесь стоял голый new Date(`${date}T${time}`) — он брал часовой пояс
            // УСТРОЙСТВА, и у агента вне Душанбе время показа молча съезжало на разницу
            // поясов. Найдено аудитом 06.08.2026.
            nextActionDate: nextActionDate
              ? nextActionTime
                ? dushanbeInputToIso(nextActionDate, nextActionTime)
                : nextActionDate
              : undefined,
          }),
        updateCard: Object.keys(cardPatch).length > 0 ? () => updateClient.mutateAsync(cardPatch) : null,
      });

      onSaved?.(outcome || undefined);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось сохранить";
      // Разговор уже в истории — говорим это прямо, иначе человек решит, что
      // не сохранилось ничего, и запишет разговор заново.
      setError(savedNow ? `Разговор сохранён, карточку клиента обновить не удалось: ${message}` : message);
    }
  }

  const stepTitle = scheduling ? "Назначить показ" : step === 1 ? "Что было" : step === 2 ? "Как прошло" : "Что дальше";
  // Номер шага виден всегда: без него человек не знает, сколько ещё осталось, и
  // бросает форму на середине. В планировании шаг один — счётчик только путал бы.
  const title = scheduling ? stepTitle : `${stepTitle} · шаг ${step} из ${TOTAL_STEPS}`;

  return (
    <>
      <Rh2Sheet
        title={title}
        ariaLabel={scheduling ? "Назначить показ" : "Записать разговор с клиентом"}
        onClose={() => requestCloseRef.current()}
        // Клик мимо окна НЕ закрывает: заметку о разговоре часто надиктовывают или
        // набирают на телефоне, и промах пальцем стирал весь текст без вопроса.
        // Esc, смахивание и «Закрыть» проходят через тот же вопрос о потере.
        closeOnBackdrop={false}
        onSubmit={handleSubmit}
        footer={
          <>
            <button
              type="button"
              className="pill ghost"
              onClick={step === 1 ? () => requestCloseRef.current() : () => setStep((s) => s - 1)}
            >
              {step === 1 ? "Отмена" : "Назад"}
            </button>
            {step < TOTAL_STEPS ? (
              <button
                type="button"
                // «Далее» — button, а НЕ submit: в форме одна submit-кнопка, и Enter
                // в поле не должен сохранять взаимодействие с половиной полей.
                onClick={() => setStep((s) => s + 1)}
                // Заметка обязательна: без неё запись бессмысленна, а на втором шаге
                // подсказывать уже поздно — ИИ разбирает именно её.
                disabled={step === 1 && !notes.trim()}
                className="pill"
              >
                Далее
              </button>
            ) : (
              <button type="submit" className="pill" disabled={accountReadOnly || addInteraction.isPending}>
                {addInteraction.isPending ? "Сохранение…" : "Сохранить"}
              </button>
            )}
          </>
        }
      >
        <CleanRecordForm enabled={clean}>
        <ReadOnlyRecordFields readOnly={accountReadOnly}>
        {clean && <CleanInteractionContext name={selectedClientName ?? contextClient.data?.displayName ?? contextClient.data?.fullName} isLoading={contextClient.isLoading} isError={contextClient.isError} onRetry={() => void contextClient.refetch()} scheduling={scheduling} />}
        {/* Условный рендер, а не hidden: в этом репозитории `hidden` не скрывает
            элемент с классом flex/grid. Состояние полей живёт в useState, поэтому
            размонтирование ничего не теряет. */}
        {scheduling && (
          <>
            <div className="fld">
              <span className="lab">Объект</span>
              <ShowingPropertyPicker value={propertyId} onChange={setPropertyId} />
            </div>
            <div className="fgrid" style={{ marginTop: "var(--s3)" }}>
              <label className="fld">
                <span className="lab">Дата показа *</span>
                <input
                  type="date"
                  required
                  value={nextActionDate}
                  /* Назначить показ задним числом нельзя: CRM тут же откроет по
                     нему обязательный «Итог показа» встречи, которой не было. */
                  min={dushanbeTodayKey()}
                  onChange={(e) => setNextActionDate(e.target.value)}
                />
              </label>
              <label className="fld">
                <span className="lab">Время *</span>
                <input type="time" required value={nextActionTime} onChange={(e) => setNextActionTime(e.target.value)} />
              </label>
            </div>
            <p className="quiet">
              <span className="dot" />
              <span className="txt">Показ попадёт в календарь, напомним за 2 часа и за 40 минут.</span>
            </p>
            <label className="fld">
              <span className="lab">Комментарий, по желанию</span>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Например: клиент придёт с семьёй"
              />
            </label>
          </>
        )}

        {!scheduling && step === 1 && (
          <>
            <label className="fld">
              <span className="lab">Что было</span>
              <textarea
                required
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Опишите разговор или встречу…"
              />
              {speech.error && <span className="msg">{speech.error}</span>}
            </label>
            {speech.supported && (
              <button
                type="button"
                className="pill ghost sm"
                style={{ marginTop: "var(--s2)" }}
                disabled={speech.isTranscribing}
                onClick={() => (speech.isListening ? speech.stop() : speech.start())}
              >
                {speech.isListening ? <MicOff className="i" strokeWidth={1.5} /> : <Mic className="i" strokeWidth={1.5} />}
                {speech.isListening ? "Остановить запись" : speech.isTranscribing ? "Распознаю…" : "Надиктовать"}
              </button>
            )}

            {/* Кнопки «Разобрать (ИИ)» здесь больше нет (решение владельца 01.08.2026).
                Разбор запускается сам, когда агент дописал заметку. */}
            {parseNote.isPending ? (
              <p className="state">Разбираю заметку…</p>
            ) : (
              aiNote && <p className="state">{aiNote}</p>
            )}

            {clientUpdates && (
              <div className="card flat">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={applyClientUpdates}
                    onChange={(e) => setApplyClientUpdates(e.target.checked)}
                  />
                  ИИ также обновит карточку клиента
                </label>
                <p className="state">
                  {[
                    clientUpdates.budgetMin || clientUpdates.budgetMax
                      ? `Бюджет: от ${clientUpdates.budgetMin ?? "?"} до ${clientUpdates.budgetMax ?? "?"}`
                      : null,
                    clientUpdates.desiredDistrict ? `Район: ${clientUpdates.desiredDistrict}` : null,
                    clientUpdates.desiredRooms ? `Комнат: ${clientUpdates.desiredRooms}` : null,
                    clientUpdates.requirementsNotes ? `Требования: ${clientUpdates.requirementsNotes}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            )}
          </>
        )}

        {step === 2 && !scheduling && (
          <>
            {type === "SHOWING" && (
              <div className="fld">
                <span className="lab">Какой объект показывали</span>
                <ShowingPropertyPicker value={propertyId} onChange={setPropertyId} allowEmpty />
                <span className="msg">
                  Показ засчитается объекту: по этому счётчику видно, какие объекты возят смотреть, а какие лежат.
                </span>
              </div>
            )}

            <div className="fgrid" style={{ marginTop: "var(--s3)" }}>
              <label className="fld">
                <span className="lab">Тип</span>
                <select
                  value={type}
                  // Точный тип вместо as any: с приведением к any компилятор переставал
                  // видеть это место, и переименуй кто-нибудь значение в TYPES — форма
                  // молча продолжала бы слать старое.
                  onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {INTERACTION_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fld">
                <span className="lab">Исход</span>
                <select value={outcome} onChange={(e) => setOutcome(e.target.value as InteractionOutcome | "")}>
                  <option value="">не выбрано</option>
                  {outcomeChoices.map((o) => (
                    <option key={o} value={o}>
                      {INTERACTION_OUTCOME_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* Что произойдёт после сохранения — до нажатия, а не после: иначе агент
                узнаёт о правилах системы, только столкнувшись с ними. */}
            {outcome === "NO_ANSWER" && (
              <p className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  Через 15 минут придёт напоминание перезвонить. Три «не ответил» подряд: руководство получит
                  уведомление.
                </span>
              </p>
            )}
            {outcome === "WAITING_SHOWING" && (
              <p className="quiet">
                <span className="dot" />
                <span className="txt">
                  На следующем шаге укажите дату и время показа, они обязательны для этого исхода, напомним за 2 часа
                  и за 40 минут.
                </span>
              </p>
            )}
            {outcome === "WAITING_OPTIONS" && (
              <p className="quiet">
                <span className="dot" />
                <span className="txt">
                  После сохранения откроется переписка на этой же карточке (если клиент писал из мессенджера), там же
                  можно подобрать и отправить ссылки на объекты из окна «Подобрать объект».
                </span>
              </p>
            )}
            {outcome === "NEGATIVE" && (
              <p className="quiet crit">
                <span className="dot crit" />
                {/* Кнопки «Отказался» в карточке нет с переработки 12.08.2026 — её заменили
                    «Завершить сделку» → «Без сделки». Подсказка отправляла агента искать
                    несуществующую кнопку. */}
                <span className="txt">
                  Если клиент отказался совсем, оформите это кнопкой «Завершить сделку» в карточке и выберите «Без
                  сделки»: там причина и комментарий обязательны. Кнопка доступна после первого проведённого показа; до
                  него используйте «Передача» или «Неактивный».
                </span>
              </p>
            )}
            {outcome === "PROPERTY_ACCEPTED" && (
              <p className="quiet">
                <span className="dot ok" />
                <span className="txt">
                  Через 36 часов (в рабочее время с 10:00 до 15:00) CRM откроет обязательное окно «Итог объекта».
                </span>
              </p>
            )}
          </>
        )}

        {step === 3 && !scheduling && (
          <>
            <label className="fld">
              <span className="lab">Следующий шаг</span>
              <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="Например: перезвонить" />
            </label>
            <div className="fgrid" style={{ marginTop: "var(--s3)" }}>
              <label className="fld">
                <span className="lab">Дата следующего шага{outcome === "WAITING_SHOWING" && " *"}</span>
                <input
                  type="date"
                  required={outcome === "WAITING_SHOWING"}
                  value={nextActionDate}
                  onChange={(e) => setNextActionDate(e.target.value)}
                />
              </label>
              <label className="fld">
                <span className="lab">Время{outcome === "WAITING_SHOWING" && " *"}</span>
                <input
                  type="time"
                  value={nextActionTime}
                  onChange={(e) => setNextActionTime(e.target.value)}
                  disabled={!nextActionDate}
                />
                <span className="msg">
                  {type === "SHOWING" ? "Напомним за 2 часа и за 40 минут" : "Напомним за час"}
                </span>
              </label>
            </div>
          </>
        )}

        {error && (
          <p className="quiet crit">
            <span className="dot crit" />
            <span className="txt">{error}</span>
          </p>
        )}
        </ReadOnlyRecordFields>
        </CleanRecordForm>
      </Rh2Sheet>

      {confirmClose && (
        <ConfirmDialog
          title="Закрыть без сохранения?"
          description="Заметка о разговоре и заполненные поля будут потеряны."
          confirmLabel="Закрыть"
          onConfirm={onClose}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}

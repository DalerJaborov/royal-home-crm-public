import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, RotateCcw, Send, Sparkles, X } from "lucide-react";
import type { AssistantActionView, AssistantCard } from "@royal-home/shared";
import { AssistantStreamError, streamAssistant } from "../lib/assistantStream";
import { loadAssistantHistory, saveAssistantHistory } from "../lib/assistantHistory";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { ASSISTANT_CATEGORIES } from "../lib/assistantCategories";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useMobileUx } from "../hooks/useMobileUx";
import { AssistantThread, type LiveTurn } from "./assistant/AssistantThread";
import { historyForStorage, pushStep, replaceAction, upsertAction, type ThreadMessage, type TurnStep } from "./assistant/assistantTurn";
import { ConfirmCard, createConfirmCardController } from "./assistant/ConfirmCard";
import type { ConfirmCardController } from "./assistant/confirmCardModel";

/** Ответ оборвался, а карточка действия уже пришла: её всё равно надо показать — действие на сервере ждёт решения. */
const BROKEN_REPLY_WITH_ACTIONS = "Ответ оборвался, но действие уже подготовлено — проверьте карточку ниже и решите сами.";

interface PanelError {
  message: string;
  retryable: boolean;
}

function toPanelError(err: unknown): PanelError {
  if (err instanceof AssistantStreamError) return { message: err.message, retryable: err.retryable };
  return { message: err instanceof Error ? err.message : "ИИ недоступен, попробуйте позже", retryable: true };
}

export function AssistantPanel({
  onClose,
  autoStartVoice,
  initialPrompt,
}: {
  onClose: () => void;
  autoStartVoice?: boolean;
  /** Подсказка, которую панель отправляет сама сразу при открытии (без лишнего клика по чипу). */
  initialPrompt?: string;
}) {
  // Диалог переживает закрытие панели (sessionStorage, см. lib/assistantHistory.ts):
  // перешёл по ссылке из ответа и вернулся — переписка на месте.
  const [messages, setMessages] = useState<ThreadMessage[]>(() => loadAssistantHistory());
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  // Лента шагов текущего хода (SSE `status`, П4а): чипы, пройденные — с «✓».
  // Одинаково на телефоне и на компьютере.
  const [steps, setSteps] = useState<TurnStep[]>([]);
  // Текст ответа по мере генерации (SSE `token`) — живой пузырь.
  const [liveText, setLiveText] = useState("");
  // Карточки, пришедшие до финального текста (быстрый путь без модели).
  const [liveCards, setLiveCards] = useState<AssistantCard[]>([]);
  // Карточки действий (SSE `confirm`) текущего хода.
  const [liveActions, setLiveActions] = useState<AssistantActionView[]>([]);
  // Состояние карточек действий — по id, а не в самой карточке: карточка
  // переезжает из текущего хода в готовую реплику и монтируется заново.
  const controllersRef = useRef(new Map<string, ConfirmCardController>());
  // Старый id → действие, на которое карточку перевели (STALE): ход, ещё собирающий реплику, берёт новое.
  const replacedRef = useRef(new Map<string, AssistantActionView>());
  const status = steps.length > 0 ? steps[steps.length - 1].text : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);
  const seededRef = useRef(false);

  const speech = useSpeechRecognition((transcript) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    inputRef.current?.focus();
  });

  // Телефонное поведение — по устройству (useMobileUx), не по вкусу в настройках
  // (см. хук). Хук вызван здесь, ДО любых ранних return, как и все остальные.
  const mobile = useMobileUx();
  const mobileEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobile) return;
    mobileEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [mobile, messages, pending, liveCards, liveActions, liveText]);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Закрытие панели обрывает идущий запрос: ответ некому показывать, а сервер
  // не должен продолжать раунды модели впустую.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // Только текст: карточки действий в хранилище не пишутся, и после повторного
    // открытия панели исполненное действие заново не предлагается (assistantTurn.ts).
    saveAssistantHistory(historyForStorage(messages));
  }, [messages]);

  // Удержание кнопки «+» в нижней навигации открывает панель СРАЗУ со включённым
  // микрофоном (прототип: «Удержите кнопку — заполню голосом») — не отдельная
  // куцая транскрипция в 2-3 экрана, а тот же полноценный ассистент, что умеет
  // ставить задачи/переносить встречи по свободной речи через /ai/assistant.
  useEffect(() => {
    if (autoStartVoice && speech.supported) speech.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartVoice]);

  useEffect(() => {
    if (!initialPrompt || seededRef.current) return;
    seededRef.current = true;
    void send(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, liveCards, liveActions, liveText]);

  // Окна отката и сроки подтверждения считают таймеры контроллеров — при закрытии
  // панели снимаем их все, а не держим живыми в памяти вкладки.
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const c of controllers.values()) c.stop();
      controllers.clear();
    };
  }, []);

  /**
   * Контроллер карточки действия по id: один на действие, сколько бы раз оно ни
   * пришло. Зовётся при отрисовке, поэтому ничего не меняет у уже известного —
   * свежий статус с сервера принимает `onConfirm` (вне отрисовки).
   */
  const controllerFor = useCallback((action: AssistantActionView) => {
    const known = controllersRef.current.get(action.id);
    if (known) return known;
    const created = createConfirmCardController(action);
    controllersRef.current.set(action.id, created);
    // 409 STALE принёс новое действие: переезжаем на его id (ключ контроллера и реплики), без второй карточки.
    created.onReplace = (oldId, next) => {
      const controllers = controllersRef.current;
      if (controllers.get(oldId) === created) controllers.delete(oldId);
      controllers.set(next.id, created);
      replacedRef.current.set(oldId, next);
      if (unmountedRef.current) return;
      setLiveActions((prev) => replaceAction(prev, oldId, next));
      setMessages((prev) => prev.map((m) => (m.actions ? { ...m, actions: replaceAction(m.actions, oldId, next) } : m)));
    };
    return created;
  }, []);

  /** Один запрос к помощнику по готовой истории (последняя реплика — вопрос человека). */
  const ask = useCallback(async (history: ThreadMessage[]) => {
    setError(null);
    setSteps([]);
    setLiveText("");
    setLiveCards([]);
    setLiveActions([]);
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const cards: AssistantCard[] = [];
    let actions: AssistantActionView[] = [];
    const withExtras = (content: string): ThreadMessage => ({
      role: "assistant",
      content,
      ...(cards.length > 0 ? { cards } : {}),
      ...(actions.length > 0 ? { actions: actions.map((a) => replacedRef.current.get(a.id) ?? a) } : {}),
    });
    try {
      const reply = await streamAssistant(
        history,
        (message) => {
          if (!unmountedRef.current) setSteps((prev) => pushStep(prev, message));
        },
        {
          signal: controller.signal,
          onCard: (card) => {
            cards.push(card);
            if (!unmountedRef.current) setLiveCards([...cards]);
          },
          onToken: (textSoFar) => {
            if (!unmountedRef.current) setLiveText(textSoFar);
          },
          onConfirm: (action) => {
            actions = upsertAction(actions, action);
            controllersRef.current.get(action.id)?.sync(action);
            if (!unmountedRef.current) setLiveActions(actions);
          },
        },
      );
      if (unmountedRef.current) return;
      setMessages([...history, withExtras(reply)]);
    } catch (err) {
      if (unmountedRef.current) return;
      // Действие уже лежит на сервере и ждёт решения — карточку не теряем вместе с ответом.
      if (actions.length > 0) setMessages([...history, withExtras(BROKEN_REPLY_WITH_ACTIONS)]);
      const failure = toPanelError(err);
      // Человек сам нажал «Остановить» — это не сбой, но вопрос остался без ответа: даём повторить.
      // Пришла карточка действия — исход хода в ней; повтор задал бы тот же вопрос второй раз.
      setError(
        err instanceof AssistantStreamError && err.code === "aborted"
          ? { message: "Остановлено", retryable: actions.length === 0 }
          : { ...failure, retryable: failure.retryable && actions.length === 0 },
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!unmountedRef.current) {
        setPending(false);
        setSteps([]);
        setLiveText("");
        setLiveCards([]);
        setLiveActions([]);
      }
    }
  }, []);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const next: ThreadMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    await ask(next);
  }

  function retry() {
    if (pending || messages.length === 0) return;
    void ask(messages);
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newDialog() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setLiveCards([]);
    setLiveActions([]);
    setLiveText("");
    setSteps([]);
    for (const c of controllersRef.current.values()) c.stop();
    controllersRef.current.clear();
    inputRef.current?.focus();
  }

  const live: LiveTurn = { pending, steps, text: liveText, cards: liveCards, actions: liveActions };
  const thread = (
    <AssistantThread
      messages={messages}
      live={live}
      onNavigate={onClose}
      onStop={stop}
      renderAction={(action) => (
        <ConfirmCard action={action} layout={mobile ? "rows" : "columns"} controller={controllerFor(action)} />
      )}
    />
  );

  const errorLine = error && (
    <p className="state err" role="alert">
      <span className="dot crit" />
      {error.message}
      {error.retryable && (
        <button type="button" className="lk" onClick={retry}>
          Повторить
        </button>
      )}
    </p>
  );

  /**
   * ОБЛИК НА ТЕЛЕФОНЕ — шторка снизу с кругом-микрофоном, дословно по макету
   * c99db05f (владелец 14.09.2026: «нашего ассистента полностью убери и
   * поставь ассистента, который появляется при зажатой кнопке плюс, он очень
   * эффектный, как приложение прямо»). Разметка и классы `.mic`/`.orb`/`.hints`
   * взяты из блока «assistant sheet» артефакта (docs/pult/theme-2026/
   * artifact-c99db05f-mobile-nav-14-09.html), стили — theme-2026-mobile-density.css
   * (область `.rh2 .scr`, см. комментарий там про причину не переиспользовать
   * `.rh2 .mh .mic`).
   *
   * ЛОГИКА НЕ МЕНЯЛАСЬ: тот же `speech` (useSpeechRecognition), та же функция
   * `send`, тот же разбор ответа `renderContent` со ссылками-переходами.
   * Меняется только порядок показа — сначала круг и статус слушания, переписка
   * (`.thread`/`.bub`) появляется под ним, как только в ней есть что показать
   * («ответ показывается после»), а не до.
   */
  if (mobile) {
    const listening = speech.isListening;
    const transcribing = speech.isTranscribing;
    const statusText = listening
      ? "Слушаю… говорите"
      : transcribing
        ? "Распознаю…"
        : pending
          ? (status ?? "Думаю…")
          : messages.length > 0
            ? "Спросите ещё раз голосом или напишите ниже"
            : "Спросите про клиента, объект или что делать дальше";

    return (
      <Rh2Sheet
        open
        onClose={onClose}
        title="Ассистент"
        ariaLabel="ИИ-ассистент"
        // Отправка — через форму самой шторки (Rh2Sheet всегда <form>), а не своей
        // формой в подвале: вложенная форма отправлялась браузером мимо React, и
        // страница перезагружалась на «/?» вместо вопроса помощнику (найдено
        // кадрами П4а, 01.11.2026; правило — шапка Rh2Sheet.tsx).
        onSubmit={() => void send(input)}
        footer={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              ref={inputRef}
              className="inp"
              style={{ flex: 1 }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Написать сообщение…"
              aria-label="Вопрос ассистенту"
            />
            <button type="submit" className="call" disabled={pending || !input.trim()} aria-label="Отправить">
              <Send className="i" />
            </button>
          </div>
        }
      >
        <div className={listening ? "mic on" : "mic"}>
          {/* Круг виден всегда, независимо от того, сыграла ли анимация дыхания
              кольца (`.mic.on .orb::after`) — анимация никогда не отвечает за
              видимость (грабли проекта). */}
          <button
            type="button"
            className="orb"
            aria-pressed={listening}
            aria-label={listening ? "Слушаю. Нажмите, чтобы остановить" : "Включить микрофон"}
            disabled={!speech.supported || transcribing}
            onClick={() => (listening ? speech.stop() : speech.start())}
          >
            {listening ? <Mic className="i" /> : <Sparkles className="i" />}
          </button>
          <p aria-live="polite">{statusText}</p>
          {messages.length === 0 && (
            <div className="hints">
              {ASSISTANT_CATEGORIES.slice(0, 3).map(({ label, example }) => (
                <button key={label} type="button" className="pill ghost sm" onClick={() => void send(example)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {messages.length > 0 && !pending && (
            <button type="button" className="pill ghost sm" onClick={newDialog}>
              Новый диалог
            </button>
          )}
        </div>

        {(messages.length > 0 || pending || liveCards.length > 0) && (
          <div className="thread">
            {thread}
            <div ref={mobileEndRef} />
          </div>
        )}

        {errorLine}
      </Rh2Sheet>
    );
  }

  /**
   * ОБЛИК НА ПК — плавающее окно `.cw` эталона (то же, что у окна звонка): шапка
   * `.cw-h`, тело `.cw-b`, подвал `.cw-f`. Именно `.cw`, а не `.sheet`: панель
   * задумана компактным виджетом в духе Jivo/Intercom, который не закрывает
   * работу под собой, и полноэкранная шторка сломала бы этот замысел. Геометрия
   * совпадает с прежней до пикселя (справа снизу, 380 px) — она и в эталоне
   * такая. Не менялось 14.09.2026 (владелец просил менять только телефон).
   *
   * Портал с областью темы обязателен: панель открывается с любого экрана, в том
   * числе ещё не перенесённого (см. Rh2Scope.tsx).
   */
  return (
    <Rh2Portal>
      {/* Прозрачный клик-перехватчик для закрытия по клику вне — без затемнения всего
          экрана: компактный виджет, а не модальный слайд-овер. */}
      <div className="sheet-back" style={{ background: "transparent", backdropFilter: "none" }} onClick={onClose} />
      <div className="cw" role="dialog" aria-label="ИИ-ассистент" data-no-sheet onClick={(e) => e.stopPropagation()}>
        <div className="cw-h">
          <div className="t">
            <b>ИИ-ассистент CRM</b>
            <span>Отвечает по данным вашего агентства</span>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              className="call"
              onClick={newDialog}
              disabled={pending}
              title="Новый диалог"
              aria-label="Новый диалог"
            >
              <RotateCcw className="i" />
            </button>
          )}
          <button type="button" className="call" onClick={onClose} aria-label="Закрыть">
            <X className="i" />
          </button>
        </div>

        <div ref={scrollRef} className="cw-b">
          {messages.length === 0 && (
            <>
              <p className="state">
                Спрашивайте своими словами: я найду в базе объекты и клиентов, посчитаю статистику, подниму историю
                встреч и, если попросите, создам задачу или перенесу встречу. Отвечаю только по работе агентства.
                Номер объекта (ОБ-000088), телефон или ссылка на пост Instagram — открою карточку сразу.
              </p>
              <p className="state">
                Ниже подсказки под ваш личный кабинет: «мои клиенты» и «встречи» относятся именно к вам,
                а не ко всей команде. Нажмите на любую, чтобы сразу отправить.
              </p>
              <div className="aib-sugg">
                {ASSISTANT_CATEGORIES.map(({ icon: Icon, label, example }) => (
                  <button key={label} type="button" onClick={() => void send(example)} title={label}>
                    <Icon className="i" />
                    {example}
                  </button>
                ))}
              </div>
            </>
          )}

          {(messages.length > 0 || pending || liveCards.length > 0) && (
            <div className="thread" style={{ padding: 0, background: "transparent" }}>
              {thread}
            </div>
          )}

          {errorLine}

          {/* Пилюля записи — по прототипу: круглый микрофон, статус-подпись.
              Живого текста распознавания здесь нет физически: запись идёт через
              MediaRecorder и уходит на расшифровку целиком ПОСЛЕ отпускания
              (useSpeechRecognition.ts), а не построчно во время речи. */}
          {(speech.isListening || speech.isTranscribing) && (
            <p className="quiet">
              <span className={speech.isListening ? "dot crit" : "dot warn"} />
              <span className="txt">{speech.isListening ? "Слушаю…" : "Распознаю…"}</span>
            </p>
          )}
        </div>

        <form
          className="cw-f"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          {speech.supported && (
            <button
              type="button"
              className="call"
              disabled={speech.isTranscribing}
              onClick={() => (speech.isListening ? speech.stop() : speech.start())}
              title={speech.isListening ? "Остановить запись" : speech.isTranscribing ? "Распознаю…" : "Голосовой ввод"}
              aria-label="Голосовой ввод"
            >
              <Mic className="i" />
            </button>
          )}
          <input
            ref={inputRef}
            className="inp"
            style={{ maxWidth: "none", flex: 1 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              speech.isListening ? "Слушаю…" : speech.isTranscribing ? "Распознаю…" : "Спросите о клиентах, объектах, цифрах"
            }
            aria-label="Вопрос ассистенту"
          />
          <button type="submit" className="call" disabled={pending || !input.trim()} aria-label="Отправить">
            <Send className="i" />
          </button>
        </form>
      </div>
    </Rh2Portal>
  );
}

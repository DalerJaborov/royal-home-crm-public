import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Mic, RotateCcw, Send, Sparkles, X } from "lucide-react";
import type { AssistantCard } from "@royal-home/shared";
import {
  AssistantStreamError,
  streamAssistant,
  type AssistantMessage as Message,
} from "../lib/assistantStream";
import { loadAssistantHistory, saveAssistantHistory } from "../lib/assistantHistory";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { ASSISTANT_CATEGORIES } from "../lib/assistantCategories";
import { AssistantCardList } from "./AssistantCards";
import { renderAssistantContent } from "./assistantContent";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useMobileUx } from "../hooks/useMobileUx";

/** Реплика в окне + карточки результата, пришедшие вместе с ответом (в историю хранилища не попадают). */
type ThreadMessage = Message & { cards?: AssistantCard[] };

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
  // Пошаговый статус текущего раунда/тула (SSE, план B3) — заменяет статичное
  // «Думаю…» на всё время диалога. Одинаково на телефоне и на компьютере.
  const [status, setStatus] = useState<string | null>(null);
  // Карточки, пришедшие до финального текста (быстрый путь без модели).
  const [liveCards, setLiveCards] = useState<AssistantCard[]>([]);
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
  }, [mobile, messages, pending, liveCards]);

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
    saveAssistantHistory(messages.map(({ role, content }) => ({ role, content })));
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
  }, [messages, pending, liveCards]);

  /** Один запрос к помощнику по готовой истории (последняя реплика — вопрос человека). */
  const ask = useCallback(async (history: ThreadMessage[]) => {
    setError(null);
    setStatus(null);
    setLiveCards([]);
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const cards: AssistantCard[] = [];
    try {
      const reply = await streamAssistant(history, setStatus, {
        signal: controller.signal,
        onCard: (card) => {
          cards.push(card);
          if (!unmountedRef.current) setLiveCards([...cards]);
        },
      });
      if (unmountedRef.current) return;
      setMessages([...history, { role: "assistant", content: reply, ...(cards.length > 0 ? { cards } : {}) }]);
    } catch (err) {
      if (unmountedRef.current) return;
      const failure = toPanelError(err);
      // Человек сам нажал «Остановить» — это не сбой, но вопрос остался без ответа: даём повторить.
      setError(
        err instanceof AssistantStreamError && err.code === "aborted"
          ? { message: "Остановлено", retryable: true }
          : failure,
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!unmountedRef.current) {
        setPending(false);
        setStatus(null);
        setLiveCards([]);
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
    setStatus(null);
    inputRef.current?.focus();
  }

  const thread = (
    <>
      {messages.map((m, i) => (
        <Fragment key={i}>
          <div className={m.role === "user" ? "bub me" : "bub"}>
            {m.role === "assistant" ? renderAssistantContent(m.content, onClose) : m.content}
          </div>
          {m.cards && <AssistantCardList cards={m.cards} onNavigate={onClose} />}
        </Fragment>
      ))}
      <AssistantCardList cards={liveCards} onNavigate={onClose} />
      {pending && (
        <div className="bub bot" role="status">
          <span className="who">ИИ-ассистент</span>
          {status ?? "Думаю…"}{" "}
          <button type="button" className="lk" onClick={stop}>
            Остановить
          </button>
        </div>
      )}
    </>
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
        footer={
          <form
            style={{ display: "flex", gap: 8, alignItems: "center" }}
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
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
          </form>
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
          <div className="thread" aria-live="polite">
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
            <div className="thread" style={{ padding: 0, background: "transparent" }} aria-live="polite">
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

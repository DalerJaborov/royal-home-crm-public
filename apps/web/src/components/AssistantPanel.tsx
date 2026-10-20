import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Mic, Send, Sparkles, X } from "lucide-react";
import { streamAssistant, type AssistantMessage as Message } from "../lib/assistantStream";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { ASSISTANT_CATEGORIES } from "../lib/assistantCategories";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useMobileUx } from "../hooks/useMobileUx";

/** Ответы ассистента содержат markdown-ссылки на карточки — превращаем их в
 * навигацию роутера, остальное выводим как текст (никакого HTML от модели). */
function renderContent(text: string, onNavigate: () => void) {
  const parts: React.ReactNode[] = [];
  const regex = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Link key={key++} to={m[2]} onClick={onNavigate} className="lk">
        {m[1]}
      </Link>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function AssistantPanel({
  onClose,
  autoStartVoice,
  initialPrompt,
}: {
  onClose: () => void;
  autoStartVoice?: boolean;
  /** Пункт «Спросить ИИ» в меню кнопки «+» (FabMenu.tsx) открывает панель и сразу
   *  отправляет выбранную подсказку — без лишнего клика по чипу внутри панели. */
  initialPrompt?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Пошаговый статус текущего раунда/тула (SSE, план B3) — заменяет статичное
  // «Думаю…» на всё время диалога.
  const [status, setStatus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  }, [mobile, messages, pending]);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Удержание кнопки «+» в нижней навигации открывает панель СРАЗУ со включённым
  // микрофоном (прототип: «Удержите кнопку — заполню голосом») — не отдельная
  // куцая транскрипция в 2-3 экрана, а тот же полноценный ассистент, что умеет
  // ставить задачи/переносить встречи по свободной речи через /ai/assistant.
  useEffect(() => {
    if (autoStartVoice && speech.supported) speech.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartVoice]);

  useEffect(() => {
    if (initialPrompt) void send(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setError(null);
    setStatus(null);
    const next = [...messages, { role: "user" as const, content: trimmed }];
    setMessages(next);
    setInput("");
    setPending(true);
    try {
      const reply = await streamAssistant(next, setStatus);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ИИ недоступен, попробуйте позже");
    } finally {
      setPending(false);
      setStatus(null);
    }
  }

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
          ? "Думаю…"
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
          <p>{statusText}</p>
          {messages.length === 0 && (
            <div className="hints">
              {ASSISTANT_CATEGORIES.slice(0, 3).map(({ label, example }) => (
                <button key={label} type="button" className="pill ghost sm" onClick={() => void send(example)}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {messages.length > 0 && (
          <div className="thread">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "bub me" : "bub"}>
                {m.role === "assistant" ? renderContent(m.content, onClose) : m.content}
              </div>
            ))}
            {pending && (
              <div className="bub bot">
                <span className="who">ИИ-ассистент</span>
                Думаю…
              </div>
            )}
            <div ref={mobileEndRef} />
          </div>
        )}

        {error && (
          <p className="state err">
            <span className="dot crit" />
            {error}
          </p>
        )}
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

          {messages.length > 0 && (
            <div className="thread" style={{ padding: 0, background: "transparent" }}>
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "bub me" : "bub"}>
                  {m.role === "assistant" ? renderContent(m.content, onClose) : m.content}
                </div>
              ))}
              {pending && (
                <div className="bub bot">
                  <span className="who">ИИ-ассистент</span>
                  {status ?? "Думаю…"}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="state err">
              <span className="dot crit" />
              {error}
            </p>
          )}

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

import { useEffect, useRef, useState } from "react";
import { useBotTrainerDecide, useBotTrainerQueue, useBotTrainerVariants, type BotTrainerItem } from "../../hooks/useBotTrainer";
import { relativeTime } from "../../lib/format";
import { shownVariants } from "./trainerVariants";

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
  TELEGRAM: "Telegram",
};

type Verdict = "good" | "bad" | "mute";

/**
 * «Тренажёр бота» (17.09.2026) — одна переписка, одно решение.
 *
 * УПРОЩЕНО поверх исходного макета (docs/mockups-trainer-17-09.html) по прямой
 * правке владельца поверх брифа, тем же вечером: «компактнее и проще для
 * супер тупых, чтобы было понятно, что кликать; меньше информации и кнопок».
 * Убраны: пилюля «Серия», легенда клавиш внизу, кнопка «Показать на
 * дашборде» (виджет включается местом использования — `compact`, а не
 * тумблером на самом экране), строка «← Назад / Позже →», поиск в очереди,
 * секции «Срочно/Сегодня» в списке (просто список, срочное — красная точка),
 * подписи «клавиша N· …» под кнопками, эмодзи-тема и крупный заголовок
 * «Тема · Канал» в шапке переписки, время у всех реплик кроме ответа бота,
 * чипы под ответом. Клавиши 1/2/3/A/B/Enter/←/→/L/O — РАБОТАЮТ, просто нигде
 * не описаны на экране (решение владельца — «клавиши оставить в коде»).
 *
 * СКОРОСТЬ (владелец 17.09.2026). Переход к следующему элементу —
 * мгновенный и локальный: решение уезжает на сервер в фоне
 * (useBotTrainerDecide), при ошибке карточка возвращается и виден тост.
 * Варианты A/B запрашиваются ТОЛЬКО по «Неверно» — до этого поле для своего
 * текста уже доступно, ждать нечего. Контекст рендерится только у активного
 * элемента (очередь слева показывает только имя/тему/точку, без реплик) —
 * тридцать карточек с открытой перепиской в DOM разом никому не нужны.
 *
 * Один компонент на обе ширины: `compact` — тот же вид без панели очереди,
 * используется виджетом дашборда (см. CompactBotTrainerWidget ниже и
 * pages/home/*). ≤980px — переключатель «Очередь/Переписка» вместо сетки
 * (медиазапрос в theme-2026-proto.css, тот же приём, что и у макета).
 */
export function BotTrainer({ compact = false }: { compact?: boolean }) {
  const { data, isLoading, isError } = useBotTrainerQueue();
  const decide = useBotTrainerDecide();
  const variantsMut = useBotTrainerVariants();

  const [items, setItems] = useState<BotTrainerItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (data && !loadedRef.current) {
      loadedRef.current = true;
      setItems(data.items);
      setTotal(data.items.length);
    }
  }, [data]);

  const [panel, setPanel] = useState<"q" | "c">("c");
  const [badMode, setBadMode] = useState(false);
  const [variants, setVariants] = useState<string[] | null>(null);
  // Для какой карточки посчитаны варианты (CHAT02): запоздавший ответ не должен уйти на другую.
  const [variantsFor, setVariantsFor] = useState<string | null>(null);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [note, setNote] = useState("");
  const [showAllCtx, setShowAllCtx] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = items?.[0] ?? null;
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = current?.id ?? null;
  // Варианты видны и принимаются клавишами только на той же карточке в режиме «Неверно».
  const activeVariants = shownVariants(badMode, variants, variantsFor, current?.id ?? null);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  function showToast(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  function resetItemUi() {
    setBadMode(false);
    setVariants(null);
    setVariantsFor(null);
    setVariantsLoading(false);
    setNote("");
    setShowAllCtx(false);
  }

  function applyDecision(item: BotTrainerItem, verdict: Verdict, decisionNote?: string) {
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev));
    setDoneCount((n) => n + 1);
    resetItemUi();
    showToast("Готово, применено ко всем похожим");
    decide.mutate(
      { item, verdict, note: decisionNote },
      {
        onError: () => {
          setItems((prev) => (prev ? [item, ...prev] : [item]));
          setDoneCount((n) => Math.max(0, n - 1));
          showToast("Не удалось сохранить — карточка вернулась");
        },
      }
    );
  }

  function later(item: BotTrainerItem) {
    setItems((prev) => {
      if (!prev) return prev;
      return [...prev.filter((i) => i.id !== item.id), item];
    });
    resetItemUi();
  }

  function startBad() {
    setBadMode(true);
    setVariants(null);
    setVariantsFor(null);
    if (!current?.conversationId || !current.messageKey) return;
    const forId = current.id;
    setVariantsLoading(true);
    variantsMut.mutate(
      { conversationId: current.conversationId, messageKey: current.messageKey },
      {
        // Оператор уже ушёл на другую карточку: чужой ответ не пишем (CHAT02).
        onSuccess: (res) => {
          if (currentIdRef.current !== forId) return;
          setVariantsLoading(false);
          setVariants(res.variants ?? []);
          setVariantsFor(forId);
        },
        onError: () => {
          if (currentIdRef.current !== forId) return;
          setVariantsLoading(false);
          setVariants([]);
          setVariantsFor(forId);
        },
      }
    );
  }

  function pickFromQueue(id: string) {
    setItems((prev) => (prev ? [prev.find((i) => i.id === id)!, ...prev.filter((i) => i.id !== id)] : prev));
    resetItemUi();
  }

  function openConversation(item: BotTrainerItem) {
    if (!item.conversationId) return;
    window.open(`/messages?open=${encodeURIComponent(item.conversationId)}`, "_blank", "noopener");
  }

  // Клавиши 1/2/3/A/B/Enter/←/→/L/O — см. заголовок компонента. Виджет
  // (compact) клавишами не управляет: неожиданно перехватывать их вне
  // собственного экрана.
  useEffect(() => {
    if (compact) return;
    function onKey(e: KeyboardEvent) {
      if (!current) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Enter" && badMode && note.trim()) applyDecision(current, "bad", note.trim());
        return;
      }
      switch (e.key) {
        case "1":
          applyDecision(current, "good");
          break;
        case "2":
          if (!badMode) startBad();
          break;
        case "3":
          applyDecision(current, "mute");
          break;
        case "a":
        case "A":
        case "ф":
        case "Ф":
          if (activeVariants?.[0]) applyDecision(current, "bad", activeVariants[0]);
          break;
        case "b":
        case "B":
        case "и":
        case "И":
          if (activeVariants?.[1]) applyDecision(current, "bad", activeVariants[1]);
          break;
        case "l":
        case "L":
        case "д":
        case "Д":
          later(current);
          break;
        case "o":
        case "O":
        case "щ":
        case "Щ":
          openConversation(current);
          break;
        case "ArrowRight":
          later(current);
          break;
        case "ArrowLeft":
          setItems((prev) => {
            if (!prev || prev.length < 2) return prev;
            const arr = [...prev];
            const last = arr.pop()!;
            return [last, ...arr];
          });
          resetItemUi();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, badMode, variants, variantsFor, note, compact]);

  if (isLoading) {
    return (
      <div className={`card tr-panel show${compact ? " tr-compact" : ""}`}>
        <div className="state" style={{ padding: 20 }}>
          <span className="sk w40" />
          <span className="sk w22" /> Собираем очередь
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={`card tight${compact ? " tr-compact" : ""}`}>
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">Не удалось собрать очередь тренажёра.</span>
        </div>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className={`card tr-panel show${compact ? " tr-compact" : ""}`}>
        <div className="tr-empty">
          <p>{doneCount > 0 ? `Готово на сегодня. Решено ${doneCount} из ${total}.` : "Очередь пуста — учить пока нечему."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? "tr-compact" : "tr-wrap"}>
      {!compact && (
        <div className="tr-top">
          <h1>Тренажёр бота</h1>
          <span className="tr-count">
            {doneCount + 1} / {total}
          </span>
        </div>
      )}
      {!compact && (
        <div className="tr-seg">
          <button type="button" className={panel === "q" ? "on" : ""} onClick={() => setPanel("q")}>
            Очередь
          </button>
          <button type="button" className={panel === "c" ? "on" : ""} onClick={() => setPanel("c")}>
            Переписка
          </button>
        </div>
      )}
      <div className={compact ? undefined : "tr-grid"}>
        {!compact && (
          <section className={`card tr-panel${panel === "q" ? " show" : ""}`}>
            <TrainerQueueList items={items} onPick={pickFromQueue} />
          </section>
        )}
        <section className={`card tr-panel${!compact && panel !== "c" ? "" : " show"}`}>
          {current && (
            <TrainerConversation
              key={current.id}
              item={current}
              compact={compact}
              badMode={badMode}
              variants={activeVariants}
              variantsLoading={variantsLoading}
              note={note}
              setNote={setNote}
              showAllCtx={showAllCtx}
              setShowAllCtx={setShowAllCtx}
              onGood={() => applyDecision(current, "good")}
              onBadStart={startBad}
              onPickVariant={(text) => applyDecision(current, "bad", text)}
              onSendNote={() => {
                const text = note.trim();
                if (text) applyDecision(current, "bad", text);
              }}
              onMute={() => applyDecision(current, "mute")}
              onLater={() => later(current)}
              onOpen={() => openConversation(current)}
            />
          )}
        </section>
      </div>
      <div className={`tr-toast${toast ? " show" : ""}`}>{toast}</div>
    </div>
  );
}

function TrainerQueueList({ items, onPick }: { items: BotTrainerItem[]; onPick: (id: string) => void }) {
  return (
    <div className="tr-qlist">
      {items.map((item, i) => (
        <button type="button" key={item.id} className={`tr-row${i === 0 ? " on" : ""}`} onClick={() => onPick(item.id)}>
          <span className={`tr-dot${item.urgent ? " urgent" : ""}`} />
          <span className="tx">
            <b>
              {item.name} · {item.bucket}
            </b>
            <span>{item.a || item.q}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TrainerConversation({
  item,
  compact,
  badMode,
  variants,
  variantsLoading,
  note,
  setNote,
  showAllCtx,
  setShowAllCtx,
  onGood,
  onBadStart,
  onPickVariant,
  onSendNote,
  onMute,
  onLater,
  onOpen,
}: {
  item: BotTrainerItem;
  compact: boolean;
  badMode: boolean;
  variants: string[] | null;
  variantsLoading: boolean;
  note: string;
  setNote: (v: string) => void;
  showAllCtx: boolean;
  setShowAllCtx: (v: boolean) => void;
  onGood: () => void;
  onBadStart: () => void;
  onPickVariant: (text: string) => void;
  onSendNote: () => void;
  onMute: () => void;
  onLater: () => void;
  onOpen: () => void;
}) {
  const shownCtx = showAllCtx ? item.ctx : item.ctx.slice(-2);
  const hasMoreCtx = !showAllCtx && item.ctx.length > 2;

  return (
    <>
      <div className="tr-ch">
        <div className="who">
          <b>{item.name}</b>
          <span className="chip mute">{CHANNEL_LABEL[item.channel] ?? item.channel}</span>
        </div>
        <div className="acts">
          {item.conversationId && (
            <button type="button" className="lnk" onClick={onOpen} title="Открыть переписку" aria-label="Открыть переписку">
              Открыть переписку ↗
            </button>
          )}
          <button type="button" className="lnk" onClick={onLater}>
            Позже
          </button>
        </div>
      </div>

      <div className="tr-thread">
        {hasMoreCtx && (
          <button type="button" className="tr-more" onClick={() => setShowAllCtx(true)}>
            Показать весь разговор
          </button>
        )}
        {shownCtx.map((m, i) => (
          <div key={i} className={`tr-b ctx ${m.role === "user" ? "in" : "out"}`}>
            {m.text}
          </div>
        ))}
        <div className="tr-b in">{item.q}</div>
        <div className="tr-b target">
          <span className="lbl">ответ бота</span>
          {item.a}
          <span className="t">{relativeTime(item.at)}</span>
        </div>
        {badMode && (
          <>
            <div className="tr-cap">Выбери, как лучше ответить, или напиши свой</div>
            {variantsLoading && (
              <div className="tr-cap" aria-live="polite">
                Бот думает…
              </div>
            )}
            {variants?.map((v, i) => (
              <div key={i} className="tr-b alt" onClick={() => onPickVariant(v)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPickVariant(v)}>
                <kbd>{i === 0 ? "A" : "B"}</kbd>
                <span>{v}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {badMode && (
        <div className="tr-composer">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 300))}
            placeholder="Или напиши, как надо было ответить…"
            aria-label="Как надо было ответить"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSendNote();
            }}
          />
          <button type="button" className="send" disabled={!note.trim()} onClick={onSendNote} title="Отправить (Enter)">
            ➤
          </button>
        </div>
      )}

      {!badMode && (
        <div className="tr-dock">
          <div className="tr-ask">Бот ответил правильно?</div>
          <div className="tr-acts">
            <button type="button" className="tr-act good" onClick={onGood}>
              👍 Верно
            </button>
            <button type="button" className="tr-act bad" onClick={onBadStart}>
              👎 Неверно
            </button>
          </div>
          <button type="button" className="tr-mute-lnk" onClick={onMute}>
            Не надо было отвечать (спам)
          </button>
        </div>
      )}
    </>
  );
}

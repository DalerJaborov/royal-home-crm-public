import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCan } from "../lib/permissions";
import {
  LivePcmPlayer,
  appendListenText,
  listenRoleLabel,
  streamLiveVoice,
  type ListenLine,
} from "../lib/liveVoiceListen";

/**
 * «РОБОТ СЕЙЧАС НА ЛИНИИ» — ПРОСЛУШКА В РЕАЛЬНОМ ВРЕМЕНИ (09.10.2026).
 *
 * Блок вверху «Звонков»: идущие сейчас разговоры робота, кнопка «Слушать» (звук
 * разговора в браузере) и живая лента расшифровки под ней. Нет разговоров и ничего
 * не открыто — блока на экране нет вовсе.
 *
 * Данные и управление — один раз в `useLiveVoiceListenState`; разметок две, как у
 * соседнего списка (components/LiveVoiceSessions.tsx): `LiveVoiceListenDesk`
 * (пульт ПК, `.card`) и `LiveVoiceListenMh` (телефон, `.sec` + `.list` + `.row`).
 *
 * Кто видит: те же, кому открыта запись разговора робота, — права на настройки,
 * расшифровки и прослушивание сразу. Сервер проверяет их сам (403).
 */

export function useCanListenLiveVoice(): boolean {
  const can = useCan();
  return can("settings.manage") && can("calls.transcripts") && can("calls.hearRecording");
}

export interface ActiveLiveVoice {
  id: string;
  channelId: string;
  startedAt: string;
  direction: string;
  callerNumber: string | null;
  listeners: number;
}

/** Идущие разговоры робота; опрос раз в 5 секунд, пока вкладка открыта. */
function useActiveLiveVoice(enabled: boolean) {
  return useQuery({
    queryKey: ["live-voice-active"],
    queryFn: () => api<{ sessions: ActiveLiveVoice[] }>("/live-voice/active"),
    refetchInterval: 5_000,
    enabled,
    meta: { silent: true },
  });
}

type ListenPhase = "idle" | "connecting" | "listening" | "ended" | "error";

/** Кто звонит словами: направление и номер, если он известен. */
export function activeCallTitle(s: Pick<ActiveLiveVoice, "direction" | "callerNumber">): string {
  const what = s.direction === "inbound" ? "Входящий" : s.direction === "outbound" ? "Исходящий" : "Тестовый";
  return s.callerNumber ? `${what} · ${s.callerNumber}` : what;
}

function useLiveVoiceListenState() {
  const enabled = useCanListenLiveVoice();
  const { data } = useActiveLiveVoice(enabled);
  const sessions = data?.sessions ?? [];

  const [phase, setPhase] = useState<ListenPhase>("idle");
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [lines, setLines] = useState<ListenLine[]>([]);
  const [errorText, setErrorText] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playerRef = useRef<LivePcmPlayer | null>(null);

  const teardown = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    teardown();
    setPhase("idle");
    setListeningId(null);
    setLines([]);
    setErrorText(null);
  }, [teardown]);

  const listen = useCallback(
    (id: string) => {
      teardown();
      // Звук запускаем здесь же, в обработчике клика: иначе браузер его не разрешит.
      const player = new LivePcmPlayer();
      try {
        player.start();
      } catch (err) {
        setPhase("error");
        setListeningId(id);
        setErrorText(err instanceof Error ? err.message : "Не удалось включить звук");
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      playerRef.current = player;
      setPhase("connecting");
      setListeningId(id);
      setLines([]);
      setErrorText(null);

      void streamLiveVoice(
        id,
        {
          onReady: () => setPhase("listening"),
          onBacklog: (backlog) => setLines(backlog),
          onTranscript: (role, text) => setLines((prev) => appendListenText(prev, role, text)),
          onAudio: (side, samples) => player.play(side, samples),
          onEnd: () => setPhase("ended"),
        },
        controller.signal
      )
        .then(() => {
          // Поток закрылся сам: если «конец» не пришёл, всё равно считаем разговор оконченным.
          if (abortRef.current === controller) setPhase((p) => (p === "error" ? p : "ended"));
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setPhase("error");
          setErrorText(err instanceof Error ? err.message : "Не удалось подключиться к разговору");
        })
        .finally(() => {
          if (abortRef.current === controller) {
            player.stop();
            playerRef.current = null;
          }
        });
    },
    [teardown]
  );

  // Ушли со страницы — звук и соединение не должны остаться.
  useEffect(() => teardown, [teardown]);

  const visible = enabled && (sessions.length > 0 || phase !== "idle");
  return { visible, sessions, phase, listeningId, lines, errorText, listen, stop };
}

type ListenState = ReturnType<typeof useLiveVoiceListenState>;

const PHASE_TEXT: Record<ListenPhase, string> = {
  idle: "",
  connecting: "Подключаемся к разговору…",
  listening: "Вы слушаете разговор. Клиент слева, робот справа — в наушниках это слышно.",
  ended: "Разговор закончился.",
  error: "Не удалось послушать разговор.",
};

/** Живая лента: подпись говорящего и текст, прокрутка вниз за новыми репликами. */
function ListenFeed({ lines, phase }: { lines: ListenLine[]; phase: ListenPhase }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={boxRef}
      role="log"
      aria-live="polite"
      aria-label="Расшифровка разговора"
      onScroll={(e) => {
        const el = e.currentTarget;
        // Прокрутили вверх читать — не дёргаем вниз, пока не вернутся к концу.
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      style={{
        maxHeight: 260,
        overflowY: "auto",
        marginTop: 8,
        padding: "8px 0",
        fontSize: "var(--fs-15)",
        color: "var(--body)",
      }}
    >
      {lines.length === 0 && (
        <p style={{ color: "var(--faint)" }}>
          {phase === "listening" ? "Пока никто ничего не сказал." : "Расшифровка появится здесь."}
        </p>
      )}
      {lines.map((l, i) => (
        <p key={i} style={{ margin: "0 0 6px", textWrap: "pretty" }}>
          <b style={{ color: l.role === "client" ? "var(--ink)" : "var(--accent)" }}>{listenRoleLabel(l.role)}:</b> {l.text}
        </p>
      ))}
    </div>
  );
}

/** Разметка пульта (ПК). */
export function LiveVoiceListenDesk() {
  const s = useLiveVoiceListenState();
  if (!s.visible) return null;
  return <ListenDeskView s={s} />;
}

function ListenDeskView({ s }: { s: ListenState }) {
  return (
    <div className="card" style={{ marginBottom: "var(--s4)" }}>
      <div className="sec-t">Робот сейчас на линии</div>
      {s.sessions.map((a) => (
        <div key={a.id} className="quiet">
          <span className="dot ok" />
          <span className="txt">
            {activeCallTitle(a)} ·{" "}
            {new Date(a.startedAt).toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" })}
          </span>
          <button
            type="button"
            className="pill"
            onClick={() => s.listen(a.id)}
            disabled={s.listeningId === a.id && (s.phase === "connecting" || s.phase === "listening")}
          >
            {s.listeningId === a.id && s.phase === "listening" ? "Слушаете" : "Слушать"}
          </button>
        </div>
      ))}
      <ListenPanel s={s} buttonClass="pill ghost" />
    </div>
  );
}

/** Статус и лента под списком — общее для обеих разметок. */
function ListenPanel({ s, buttonClass }: { s: ListenState; buttonClass: string }) {
  if (s.phase === "idle") return null;
  const endedOrFailed = s.phase === "ended" || s.phase === "error";
  return (
    <div style={{ marginTop: 8 }}>
      <p
        role={s.phase === "error" ? "alert" : "status"}
        style={{ fontSize: "var(--fs-15)", color: s.phase === "error" ? "var(--crit)" : "var(--body)" }}
      >
        {PHASE_TEXT[s.phase]} {s.phase === "error" && s.errorText}
      </p>
      <ListenFeed lines={s.lines} phase={s.phase} />
      <button type="button" className={buttonClass} onClick={s.stop}>
        {endedOrFailed ? "Закрыть" : "Стоп"}
      </button>
    </div>
  );
}

/** Разметка телефона (`.rh2 .mh`): секция с заголовком и карточкой-списком. */
export function LiveVoiceListenMh() {
  const s = useLiveVoiceListenState();
  if (!s.visible) return null;
  return (
    <div className="sec" style={{ marginTop: 12 }}>
      <div className="sec-t">
        <h2>Робот сейчас на линии</h2>
        {s.sessions.length > 0 && <span className="cnt">{s.sessions.length}</span>}
      </div>
      <div className="list">
        {s.sessions.map((a) => (
          <div key={a.id} className="row">
            <span className="b">
              <span className="n">
                <span className="nm">{activeCallTitle(a)}</span>
              </span>
              <span className="s">
                <span className="tx">
                  с {new Date(a.startedAt).toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" })}
                </span>
              </span>
            </span>
            <button
              type="button"
              className="btn pill sm"
              onClick={() => s.listen(a.id)}
              disabled={s.listeningId === a.id && (s.phase === "connecting" || s.phase === "listening")}
            >
              {s.listeningId === a.id && s.phase === "listening" ? "Слушаете" : "Слушать"}
            </button>
          </div>
        ))}
        {s.phase !== "idle" && (
          <div className="state">
            <ListenPanel s={s} buttonClass="btn pill sm" />
          </div>
        )}
      </div>
    </div>
  );
}

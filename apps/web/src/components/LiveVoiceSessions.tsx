import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useLiveVoiceRecordingUrl,
  useLiveVoiceSessions,
  type LiveVoiceSessionSummary,
} from "../hooks/useSettings";
import { ApiError } from "../lib/api";
import { useCan } from "../lib/permissions";

/**
 * ЖИВОЙ ГОЛОС ПО ТЕЛЕФОНУ — РАСШИФРОВКИ И ЗАПИСИ, ОДИН КОМПОНЕНТ НА ВСЁ
 * ПРИЛОЖЕНИЕ (23.09.2026).
 *
 * История: список появился 13.09 в Настройках → Бот («своей страницы для
 * записи и расшифровки нет вовсе»), 14.09 переехал в «Звонки» («они не должны
 * быть тут, в другом месте должны быть»). Но 17.09 правка #363, начатая до
 * переезда, вернула в Настройки вторую копию — уже со стоимостью ИИ, которой у
 * копии в «Звонках» не было. А на телефоне списка не было вовсе: мобильные
 * «Звонки» (`MobileCallsSupervisor`) — отдельный компонент, и блок туда не
 * доехал. Три места, два разных набора полей, ни одно не видно с телефона.
 *
 * Теперь данные и плеер — здесь, один раз; разметок две: `LiveVoiceSessionsDesk`
 * (пульт `.rh2 .scr`, `.fld` + `.quiet`) и `LiveVoiceSessionsMh` (макет
 * телефона `.rh2 .mh`, `.sec` + `.sec-t` + `.list` + `.row`). В Настройках
 * осталась только ссылка сюда.
 *
 * Кто видит: директор и администратор (тот же `supervisor`, что открывает им
 * журнал всей команды) — функция экспериментальная, тестовые звонки на
 * произвольный номер не должен видеть каждый агент.
 */

/**
 * Кому показывать блок целиком (аудит роботов №6, 02.10.2026). Список на сервере
 * закрыт ДВУМЯ правами сразу — settings.manage и calls.transcripts
 * (routes/settings.ts), а экран «Звонки» открывал блок по одному calls.transcripts:
 * сотрудник со вторым правом без первого получал 403 и видел «сбой связи».
 * Одна функция на ПК и телефон, чтобы условия снова не разъехались.
 */
export function useCanSeeLiveVoiceSessions(): boolean {
  const can = useCan();
  return can("settings.manage") && can("calls.transcripts");
}

/** 403 от сервера — это «нет прав», а не «сбой связи». */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

const FORBIDDEN_TEXT = "Нет прав на разговоры живого голоса: нужны «Менять настройки CRM» и доступ к расшифровкам звонков.";
const LOAD_ERROR_TEXT = "Список не загрузился. Это сбой связи, а не отсутствие звонков.";

/** Текст под списком при ошибке загрузки: отказ по правам и сбой связи — разные вещи. */
export function liveVoiceListErrorText(error: unknown): string {
  return isForbidden(error) ? FORBIDDEN_TEXT : LOAD_ERROR_TEXT;
}

/** Данные и плеер записи — общее для обеих разметок. */
function useLiveVoiceList() {
  const { data, isLoading, isError, error } = useLiveVoiceSessions();
  const canHear = useCan()("calls.hearRecording");
  const recording = useLiveVoiceRecordingUrl();
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  // Видимый плеер вместо невидимого `new Audio()`: у разговора в несколько минут
  // должны быть пауза и стоп (аудит 23.09.2026, №45).
  const [player, setPlayer] = useState<{ id: string; url: string } | null>(null);

  const listen = async (sessionId: string) => {
    setPlayingId(sessionId);
    setPlayError(null);
    try {
      const { url } = await recording.mutateAsync(sessionId);
      setPlayer({ id: sessionId, url });
    } catch (err) {
      setPlayError(
        isForbidden(err)
          ? "Нет права слушать записи разговоров."
          : "Не удалось получить запись — проверьте «Здоровье системы»."
      );
    } finally {
      setPlayingId(null);
    }
  };

  const closePlayer = () => setPlayer(null);
  return {
    sessions: data?.sessions ?? [],
    isLoading,
    isError,
    errorText: liveVoiceListErrorText(error),
    canHear,
    playingId,
    playError,
    listen,
    player,
    closePlayer,
  };
}

/** Кто на линии, когда клиента в карточках нет: подпись по направлению звонка. */
export function sessionWho(s: Pick<LiveVoiceSessionSummary, "client" | "direction">): string {
  if (s.client) return s.client.fullName;
  // Сервер без поля direction (undefined) — прежний список: без карточки был только тест.
  if (s.direction === "test" || s.direction === undefined) return "Тестовый номер";
  if (s.direction === "inbound") return "Входящий, клиента нет в базе";
  if (s.direction === "outbound") return "Исходящий, клиента нет в базе";
  return "Номер без карточки";
}

/** Кто вёл звонок словами для списка; null — поле пустое (звонки до переключателя). */
export function sessionVoiceBy(s: Pick<LiveVoiceSessionSummary, "provider">): string | null {
  if (s.provider === "elevenlabs") return "Голос и слух: ElevenLabs";
  if (s.provider === "google") return "Голос и слух: Google";
  return null;
}

/** Стоимость словами: копейки не округляем до нуля («$0.00» читалось как «бесплатно»). */
export function formatSessionCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? "< $0.01" : `$${usd.toFixed(2)}`;
}

/** «12.09.2026, 14:03 — Фаррух · hangup · ИИ: $0.04» — одна строка на обе разметки. */
function sessionLine(s: LiveVoiceSessionSummary): string {
  return [
    `${new Date(s.startedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })} — ${sessionWho(s)}`,
    sessionVoiceBy(s),
    s.endedReason,
    // null у тех, кому не положено видеть деньги (finance.view), и у сессий без
    // usageMetadata — тогда молчим, а не врём нулём.
    s.costUsd != null ? `ИИ: ${formatSessionCost(s.costUsd)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Сервер режет начало расшифровки на 300 знаках: многоточие — только у обрезанного. */
const PREVIEW_CUT_AT = 300;
export function previewText(preview: string): string {
  return preview.length >= PREVIEW_CUT_AT ? `${preview}…` : preview;
}

const HINT =
  "Расшифровка и запись каждого разговора робота на телефоне — тестового и настоящего. Запись хранится в облаке (R2); если её нет — либо разговор был короче секунды, либо облако не настроено (см. «Здоровье системы»). Настройки самого живого голоса — в Настройках → Помощник.";

function ListenButton({
  s,
  playingId,
  listen,
  player,
  closePlayer,
  className,
  canHear,
}: {
  s: LiveVoiceSessionSummary;
  playingId: string | null;
  listen: (id: string) => Promise<void>;
  player: { id: string; url: string } | null;
  closePlayer: () => void;
  className: string;
  /** Звук закрыт отдельным правом (calls.hearRecording) — без него кнопки нет. */
  canHear: boolean;
}) {
  if (!s.hasRecording || !canHear) return null;
  if (player?.id === s.id) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <audio controls autoPlay preload="none" src={player.url} style={{ height: 34, maxWidth: 260 }} />
        <button className={className} type="button" onClick={closePlayer}>
          Закрыть запись
        </button>
      </span>
    );
  }
  return (
    <button
      className={className}
      type="button"
      onClick={() => void listen(s.id)}
      disabled={playingId === s.id}
      style={{ flexShrink: 0 }}
    >
      {playingId === s.id ? "Загружаю…" : "▶ Прослушать"}
    </button>
  );
}

/** Разметка пульта (ПК). */
export function LiveVoiceSessionsDesk() {
  const { sessions, isLoading, isError, errorText, canHear, playingId, playError, listen, player, closePlayer } =
    useLiveVoiceList();

  return (
    <div className="fld" style={{ marginTop: "var(--s5)" }}>
      <span className="lab">Живой голос по телефону — последние звонки</span>
      <span className="msg">{HINT}</span>
      {isLoading && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Загрузка…</span>
        </div>
      )}
      {isError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{errorText}</span>
        </div>
      )}
      {!isLoading && !isError && sessions.length === 0 && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Звонков ещё не было.</span>
        </div>
      )}
      {sessions.map((s) => (
        <div key={s.id} className="quiet" style={{ marginTop: "var(--s2)", alignItems: "flex-start" }}>
          <span className="dot" />
          <span className="txt">
            {sessionLine(s)}
            {s.transcriptPreview && (
              <>
                <br />
                <span style={{ color: "var(--faint)" }}>{previewText(s.transcriptPreview)}</span>
              </>
            )}
          </span>
          <ListenButton
            s={s}
            canHear={canHear}
            playingId={playingId}
            listen={listen}
            player={player}
            closePlayer={closePlayer}
            className="lnk"
          />
        </div>
      ))}
      {playError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{playError}</span>
        </div>
      )}
    </div>
  );
}

/** Разметка телефона (`.rh2 .mh`): секция с заголовком и карточкой-списком. */
export function LiveVoiceSessionsMh() {
  const { sessions, isLoading, isError, errorText, canHear, playingId, playError, listen, player, closePlayer } =
    useLiveVoiceList();

  return (
    <div className="sec" style={{ marginTop: 12 }}>
      <div className="sec-t">
        <h2>Живой голос</h2>
        {sessions.length > 0 && <span className="cnt">{sessions.length}</span>}
      </div>
      <div className="list">
        {isLoading && <div className="state">Загружаем звонки живого голоса</div>}
        {isError && <div className="state err">{errorText}</div>}
        {!isLoading && !isError && sessions.length === 0 && <div className="state">Звонков ещё не было.</div>}
        {sessions.map((s) => (
          <div key={s.id} className="row">
            <span className="b">
              <span className="n">
                <span className="nm">
                  {s.client ? (
                    <Link className="lk" to={`/clients/${s.client.shortId}`}>
                      {s.client.fullName}
                    </Link>
                  ) : (
                    sessionWho(s)
                  )}
                </span>
              </span>
              <span className="s">
                <span className="tx">
                  {new Date(s.startedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", dateStyle: "short", timeStyle: "short" })}
                </span>
                {sessionVoiceBy(s) && <span className="tx">· {sessionVoiceBy(s)}</span>}
                {s.endedReason && <span className="tx">· {s.endedReason}</span>}
                {s.costUsd != null && <span className="tx">· ИИ: {formatSessionCost(s.costUsd)}</span>}
              </span>
              {s.transcriptPreview && <span className="s">{previewText(s.transcriptPreview)}</span>}
            </span>
            <ListenButton
              s={s}
              canHear={canHear}
              playingId={playingId}
              listen={listen}
              player={player}
              closePlayer={closePlayer}
              className="btn pill sm"
            />
          </div>
        ))}
        {playError && (
          <div className="state err" role="alert">
            {playError}
          </div>
        )}
      </div>
    </div>
  );
}

import { joinTranscriptFragments } from "@royal-home/shared";
import { refreshAccessToken } from "./api";
import { getOrCreateDeviceId } from "./deviceId";
import { httpStatusMessage } from "./httpStatusMessage";
import { currentSessionEpoch } from "./sessionGuard";
import { useAuthStore } from "../store/auth";

/**
 * ПРОСЛУШКА РОБОТА В РЕАЛЬНОМ ВРЕМЕНИ — КЛИЕНТСКАЯ ЧАСТЬ (09.10.2026).
 *
 * Сервер (apps/api/src/routes/liveVoiceListen.ts) отдаёт поток событий:
 * ready / backlog / transcript / audio / end. Звук — PCM16 LE, 8 кГц, моно,
 * кусками по ~100 мс, base64.
 *
 * EventSource заголовков не умеет, а доступ к потоку закрыт правами, поэтому
 * читаем fetch'ем с Bearer-токеном и разбираем кадры сами (как lib/assistantStream.ts).
 *
 * Здесь — чистые функции (тестируются без браузера), разбор потока и
 * проигрыватель Web Audio. Экран — components/LiveVoiceListen.tsx.
 */

export type ListenRole = "client" | "bot";

export interface ListenLine {
  role: ListenRole;
  text: string;
}

/** Подпись говорящего на ленте. */
export function listenRoleLabel(role: ListenRole): string {
  return role === "client" ? "Клиент" : "Робот";
}

/** Сколько реплик держим на экране: длинный разговор не должен раздувать страницу. */
export const MAX_LISTEN_LINES = 300;

/**
 * Добавляет кусок расшифровки в ленту: подряд идущие куски одного говорящего
 * склеиваются в одну реплику (модель присылает речь обрывками), смена говорящего
 * начинает новую. Не меняет переданный массив.
 */
export function appendListenText(lines: readonly ListenLine[], role: ListenRole, text: string): ListenLine[] {
  if (!text) return lines.slice();
  const last = lines[lines.length - 1];
  const next =
    last && last.role === role
      ? [...lines.slice(0, -1), { role, text: joinTranscriptFragments(last.text, text) }]
      : [...lines, { role, text }];
  return next.length > MAX_LISTEN_LINES ? next.slice(next.length - MAX_LISTEN_LINES) : next;
}

/** Base64 → PCM16 LE → числа в диапазоне [-1, 1) для Web Audio. */
export function pcm16LeBase64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const samples = Math.floor(bin.length / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const lo = bin.charCodeAt(2 * i);
    const hi = bin.charCodeAt(2 * i + 1);
    let v = (hi << 8) | lo;
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

/** Задержка перед началом воспроизведения (буфер против рывков), секунды. */
export const PLAYBACK_LEAD_SEC = 0.2;
/** Если очередь ушла дальше этого вперёд — звук отстаёт от жизни, начинаем заново. */
export const PLAYBACK_MAX_AHEAD_SEC = 1.0;

/**
 * Когда ставить следующий кусок. `nextTime` — конец уже поставленного звука этой
 * стороны, `now` — текущее время часов Web Audio. Звук идёт встык (без щелчков);
 * если очередь опустела (догнали) — выдерживаем запас PLAYBACK_LEAD_SEC; если
 * очередь стала слишком длинной — сбрасываем отставание.
 */
export function planPlaybackStart(nextTime: number, now: number): number {
  if (nextTime < now || nextTime - now > PLAYBACK_MAX_AHEAD_SEC) return now + PLAYBACK_LEAD_SEC;
  return nextTime;
}

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Достаёт из накопленного текста целые кадры SSE (разделитель — пустая строка).
 * Строки-комментарии (": ping") пропускаются. Остаток — недоставленный хвост.
 */
export function takeSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  let sep: number;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let event = "";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event && data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

export interface ListenHandlers {
  onReady?: (info: { id: string; startedAt: string; direction: string }) => void;
  onBacklog?: (lines: ListenLine[]) => void;
  onTranscript?: (role: ListenRole, text: string) => void;
  onAudio?: (side: ListenRole, samples: Float32Array) => void;
  onEnd?: (reason: string) => void;
}

/**
 * Открывает поток и читает его, пока он не закончится или не будет отменён
 * через `signal`. Бросает Error с понятным текстом, если сервер отказал.
 */
export async function streamLiveVoice(id: string, handlers: ListenHandlers, signal: AbortSignal): Promise<void> {
  const url = `/api/v1/live-voice/${encodeURIComponent(id)}/listen`;
  const doFetch = (token: string | null) =>
    fetch(url, {
      method: "GET",
      credentials: "include",
      signal,
      headers: {
        Accept: "text/event-stream",
        "X-Device-Id": getOrCreateDeviceId(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  // Поток принадлежит той сессии, в которой открыт (как в assistantStream.ts).
  const epoch = currentSessionEpoch();
  const assertSameSession = () => {
    if (currentSessionEpoch() !== epoch) throw new Error("Сессия сменилась — прослушивание остановлено");
  };

  let token = useAuthStore.getState().accessToken;
  let res = await doFetch(token);
  if (res.status === 401 && useAuthStore.getState().hasSession) {
    token = await refreshAccessToken();
    assertSameSession();
    if (token) res = await doFetch(token);
  }
  assertSameSession();

  if (!res.ok || !res.body) {
    let message = httpStatusMessage(res.status);
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Тело не JSON — остаётся текст по коду ответа.
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assertSameSession();
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = takeSseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      dispatchFrame(frame.event, data, handlers);
    }
  }
}

function asRole(value: unknown): ListenRole | null {
  return value === "client" || value === "bot" ? value : null;
}

function dispatchFrame(event: string, data: Record<string, unknown>, h: ListenHandlers): void {
  if (event === "ready") {
    h.onReady?.({ id: String(data.id ?? ""), startedAt: String(data.startedAt ?? ""), direction: String(data.direction ?? "") });
  } else if (event === "backlog") {
    const raw = Array.isArray(data.lines) ? (data.lines as unknown[]) : [];
    const lines: ListenLine[] = [];
    for (const item of raw) {
      const o = item as { role?: unknown; text?: unknown };
      const role = asRole(o?.role);
      if (role && typeof o.text === "string") lines.push({ role, text: o.text });
    }
    h.onBacklog?.(lines);
  } else if (event === "transcript") {
    const role = asRole(data.role);
    if (role && typeof data.text === "string") h.onTranscript?.(role, data.text);
  } else if (event === "audio") {
    const side = asRole(data.side);
    if (side && typeof data.b64 === "string") h.onAudio?.(side, pcm16LeBase64ToFloat32(data.b64));
  } else if (event === "end") {
    h.onEnd?.(typeof data.reason === "string" ? data.reason : "");
  }
}

/** Частота звука с сервера. */
const SOURCE_RATE_HZ = 8000;

type AudioContextCtor = typeof AudioContext;

/**
 * Проигрыватель живого звука. Клиент и робот идут на разные стороны панорамы
 * (клиент слева, робот справа) — в наушниках слышно, кто говорит; на динамике
 * телефона это обычное моно. Создавать и запускать — только из обработчика клика
 * (браузер не даёт запускать звук сам по себе).
 */
export class LivePcmPlayer {
  private ctx: AudioContext | null = null;
  private nodes: Partial<Record<ListenRole, AudioNode>> = {};
  private nextTime: Record<ListenRole, number> = { client: 0, bot: 0 };

  start(): void {
    if (this.ctx) return;
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) throw new Error("Этот браузер не умеет воспроизводить звук");
    const ctx = new Ctor();
    this.ctx = ctx;
    void ctx.resume?.();
    for (const side of ["client", "bot"] as const) {
      const gain = ctx.createGain();
      if (typeof ctx.createStereoPanner === "function") {
        const pan = ctx.createStereoPanner();
        pan.pan.value = side === "client" ? -0.7 : 0.7;
        gain.connect(pan);
        pan.connect(ctx.destination);
      } else {
        gain.connect(ctx.destination);
      }
      this.nodes[side] = gain;
    }
  }

  play(side: ListenRole, samples: Float32Array): void {
    const ctx = this.ctx;
    const node = this.nodes[side];
    if (!ctx || !node || samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, SOURCE_RATE_HZ);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(node);
    const startAt = planPlaybackStart(this.nextTime[side], ctx.currentTime);
    source.start(startAt);
    this.nextTime[side] = startAt + buffer.duration;
  }

  stop(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.nodes = {};
    this.nextTime = { client: 0, bot: 0 };
    if (ctx) void ctx.close().catch(() => {});
  }
}

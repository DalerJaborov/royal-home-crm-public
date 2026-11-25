import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Скачивает вложение переписки и отдаёт blob-ссылку на него, освобождая её при
 * размонтировании.
 *
 * Вынесено из MessageAttachments.tsx (21.09.2026, «фото в чате листаются
 * свайпом по всем фото переписки»): просмотрщик всей переписки (ChatPhotoViewer)
 * качает те же закрытые файлы тем же маршрутом, что и одиночная плитка —
 * второй копии того же fetch+blob не заводим.
 *
 * Файл нельзя вставить в `<img src>` напрямую: он лежит в закрытом хранилище и
 * отдаётся маршрутом с проверкой права по заголовку Authorization, а тег
 * `<img>` заголовков не шлёт — получилась бы битая картинка.
 */
export type AttachmentLoadState = { url: string | null; failed: boolean };

export function useAttachmentUrl(file: string | null): AttachmentLoadState {
  const [state, setState] = useState<AttachmentLoadState>({ url: null, failed: false });

  useEffect(() => {
    if (!file) return;
    // Отменять сам запрос нечем (api() не принимает signal), поэтому просто не
    // трогаем состояние после размонтирования и не создаём осиротевшую ссылку:
    // незакрытый blob держит файл в памяти вкладки до перезагрузки страницы.
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ url: null, failed: false });
    api<Blob>(`/attachments/${encodeURIComponent(file)}`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, failed: true });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return state;
}

/**
 * То же скачивание, но без хука — для просмотрщика, которому нужно держать
 * СРАЗУ несколько blob-ссылок (текущий кадр и соседей) в одной карте состояния,
 * а не заводить хук на каждое фото переписки (число кадров меняется вместе с
 * историей — нарушило бы правило порядка хуков).
 */
export async function fetchAttachmentUrl(file: string): Promise<string | null> {
  try {
    const blob = await api<Blob>(`/attachments/${encodeURIComponent(file)}`, { responseType: "blob" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Играет ли этот браузер такой тип сам (25.11.2026). Голосовые WhatsApp и
 * Telegram — ogg/opus: Chrome их играет, Safari до iOS 18.4 — нет, и честно
 * отвечает пустой строкой на canPlayType. Тогда вложение сразу берёт версию
 * m4a (`play`), не дожидаясь ошибки плеера. «maybe» считаем «да»: ошибку
 * плеера ловит запасной путь (RhAudioPlayer → fallbackSrc).
 */
const playsCache = new Map<string, boolean>();
export function browserPlays(mime: string): boolean {
  const key = mime.split(";")[0].trim().toLowerCase();
  const cached = playsCache.get(key);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    const el = document.createElement(key.startsWith("video/") ? "video" : "audio");
    // ogg без указания кодека Safari иногда отвечает «maybe», а opus в ogg не играет —
    // спрашиваем точнее, как реально лежат голосовые мессенджеров.
    const probe = key === "audio/ogg" ? 'audio/ogg; codecs="opus"' : key;
    ok = el.canPlayType(probe) !== "";
  } catch {
    ok = true;
  }
  playsCache.set(key, ok);
  return ok;
}

/**
 * Версия для браузера готова? (ревью #428). Сервер не держит запрос, пока
 * перекодирует: отвечает 503 + Retry-After и считает в фоне. Плеер на 503
 * просто «ломается», поэтому сначала спрашиваем адрес запросом HEAD и даём его
 * плееру только после 200. Ждём до двух минут, потом честно «не вышло».
 */
export type PlayableState = "idle" | "preparing" | "ready" | "failed";
const PLAYABLE_MAX_TRIES = 24;

export function usePlayableUrl(url: string | null, active: boolean): { state: PlayableState } {
  const [state, setState] = useState<PlayableState>("idle");
  useEffect(() => {
    if (!active || !url) {
      setState("idle");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState("preparing");
    const attempt = async (n: number) => {
      try {
        const res = await fetch(url, { method: "HEAD", credentials: "omit", cache: "no-store" });
        if (cancelled) return;
        if (res.ok) return setState("ready");
        if (res.status === 503 && n < PLAYABLE_MAX_TRIES) {
          const wait = Math.min(15, Math.max(2, Number(res.headers.get("Retry-After")) || 5)) * 1000;
          timer = setTimeout(() => void attempt(n + 1), wait);
          return;
        }
        setState("failed");
      } catch {
        if (!cancelled) setState("failed");
      }
    };
    void attempt(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, active]);
  return { state };
}

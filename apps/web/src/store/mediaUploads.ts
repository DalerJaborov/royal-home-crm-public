import { create } from "zustand";

/**
 * Загрузка фото/видео в переписку с прогрессом (18.08.2026, WhatsApp/Telegram-стиль
 * по просьбе владельца).
 *
 * Состояние живёт в сторе НА УРОВНЕ conversationId, а не в useState компонента чата:
 * оператор часто переключается между диалогами, пока грузится большой ролик объекта
 * (гибридный режим видео — до 1 ГБ в исходном качестве, см.
 * apps/api/src/lib/conversationDelivery.ts), и прогресс не должен пропадать с экрана,
 * если он на секунду ушёл в другой диалог и вернулся.
 */
export interface PendingMediaUpload {
  localId: string;
  /** null — пузырь поднят с сервера после перезагрузки вкладки (самого файла во вкладке уже нет). */
  file: File | null;
  /** blob-ссылка на превью (кадр видео/фото) — создаётся один раз при добавлении и
   *  освобождается при удалении записи, чтобы не копить память во вкладке. */
  previewUrl: string;
  kind: "image" | "video";
  caption?: string;
  /** 0–100. */
  progress: number;
  /** processing — файл уже на сервере, сервер сжимает и отправляет (25.11.2026, очередь отправки). */
  status: "uploading" | "processing" | "error" | "done";
  error?: string;
  /** Номер задания очереди отправки: по нему опрос состояния, «Повторить» без новой загрузки и «Отменить». */
  jobId?: string;
  /** Что сервер делает сейчас: ждёт очереди, сжимает, отправляет клиенту. */
  stage?: "queued" | "compress" | "send";
  /** false — исход отправки неизвестен (файл мог дойти): «Повторить» не показываем. */
  retryable?: boolean;
  /** Ключ повтора загрузки; новый — когда файл грузится заново (сервер его уже убрал). */
  uploadKey?: string;
}

interface MediaUploadsState {
  byConversation: Record<string, PendingMediaUpload[]>;
  add: (conversationId: string, upload: PendingMediaUpload) => void;
  setProgress: (conversationId: string, localId: string, progress: number) => void;
  setError: (conversationId: string, localId: string, error: string, retryable?: boolean) => void;
  setUploading: (conversationId: string, localId: string) => void;
  setProcessing: (conversationId: string, localId: string, patch: { jobId: string; stage: PendingMediaUpload["stage"]; progress: number }) => void;
  remove: (conversationId: string, localId: string) => void;
}

export const useMediaUploadsStore = create<MediaUploadsState>((set) => ({
  byConversation: {},
  add: (conversationId, upload) =>
    set((s) => ({
      byConversation: { ...s.byConversation, [conversationId]: [...(s.byConversation[conversationId] ?? []), upload] },
    })),
  setProgress: (conversationId, localId, progress) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((u) => (u.localId === localId ? { ...u, progress } : u)),
      },
    })),
  setError: (conversationId, localId, error, retryable = true) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((u) =>
          u.localId === localId ? { ...u, status: "error", error, retryable } : u
        ),
      },
    })),
  setUploading: (conversationId, localId) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((u) =>
          u.localId === localId ? { ...u, status: "uploading", progress: 0, error: undefined } : u
        ),
      },
    })),
  setProcessing: (conversationId, localId, patch) =>
    set((s) => ({
      byConversation: {
        ...s.byConversation,
        [conversationId]: (s.byConversation[conversationId] ?? []).map((u) =>
          u.localId === localId ? { ...u, status: "processing", error: undefined, ...patch } : u
        ),
      },
    })),
  remove: (conversationId, localId) =>
    set((s) => {
      const list = s.byConversation[conversationId] ?? [];
      const found = list.find((u) => u.localId === localId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return { byConversation: { ...s.byConversation, [conversationId]: list.filter((u) => u.localId !== localId) } };
    }),
}));

/** Пустой список — ОДНА и та же ссылка на пустой массив, а не новый литерал `[]`
 *  при каждом вызове селектора (баг найден 16.09.2026): без общей ссылки
 *  `useSyncExternalStore` видел «новый» снэпшот на каждой проверке и рендерил
 *  диалог по кругу — «Maximum update depth exceeded» в ConversationView (ПК),
 *  у любого диалога без незавершённых загрузок, то есть почти всегда. */
const EMPTY_UPLOADS: PendingMediaUpload[] = [];

/** Хук для чтения списка загрузок диалога — тонкая обёртка, чтобы компонентам не
 *  приходилось знать форму стора. */
export function usePendingMediaUploads(conversationId: string | null): PendingMediaUpload[] {
  return useMediaUploadsStore((s) => (conversationId ? s.byConversation[conversationId] ?? EMPTY_UPLOADS : EMPTY_UPLOADS));
}

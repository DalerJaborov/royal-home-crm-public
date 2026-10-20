import { useMemo, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type UploadKind, type UploadQueueState, type UploadTaskView } from "../lib/uploadQueue";

/** Всё состояние очереди — для общего указателя в шапке. */
export function useUploadQueue(): UploadQueueState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface UploadSummary {
  /** Файлов в очереди — считаем файлы, а не задания: «6 фото» человек считает шестью. */
  files: number;
  /** Заданий, остановленных отказом и ждущих решения человека. */
  failed: number;
  /** Процент задания, которое идёт прямо сейчас. */
  percent: number;
  uploading: boolean;
  /** Есть ли вообще что показывать. */
  active: boolean;
}

/** Сводка для общего указателя: одна строка на всё приложение. */
export function useUploadSummary(): UploadSummary {
  const state = useUploadQueue();
  const files = state.tasks.reduce((sum, t) => sum + t.filenames.length, 0);
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  return {
    files,
    failed,
    percent: state.activeTotal > 0 ? Math.round((state.activeLoaded / state.activeTotal) * 100) : 0,
    uploading: state.activeId !== null,
    active: state.tasks.length > 0,
  };
}

export interface PropertyUploads {
  tasks: UploadTaskView[];
  activeId: string | null;
  activeLoaded: number;
  activeTotal: number;
  /** Скользящая скорость активного задания — см. UploadQueueState.activeSpeedBps. */
  activeSpeedBps: number | null;
  /** Есть ли что-то, чего человек ждёт: идёт или ждёт очереди. */
  busy: boolean;
  /** Отказы, требующие решения человека. */
  failed: UploadTaskView[];
}

/**
 * Очередь по одной карточке и одному виду файлов.
 *
 * Отбор в useMemo, а не прямо в теле: массив-результат пересоздавался бы на
 * каждый кадр прогресса, и список заданий перерисовывался бы целиком двадцать
 * раз в секунду — вместе с перетаскиваемыми фотографиями рядом.
 */
export function usePropertyUploads(propertyId: string, kind: UploadKind): PropertyUploads {
  const state = useUploadQueue();
  const tasks = useMemo(
    () => state.tasks.filter((t) => t.propertyId === propertyId && t.kind === kind),
    [state.tasks, propertyId, kind]
  );
  const failed = useMemo(() => tasks.filter((t) => t.status === "failed"), [tasks]);
  return {
    tasks,
    activeId: state.activeId,
    activeLoaded: state.activeLoaded,
    activeTotal: state.activeTotal,
    activeSpeedBps: state.activeSpeedBps,
    busy: tasks.some((t) => t.status !== "failed"),
    failed,
  };
}

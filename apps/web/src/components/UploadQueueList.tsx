import { usePropertyUploads } from "../hooks/useUploadQueue";
import { UploadTaskRow } from "./UploadTaskRow";
import { Rh2Inline } from "./rh2/Rh2Scope";
import type { UploadKind } from "../lib/uploadQueue";

/**
 * Очередь загрузки этой карточки — прямо под кнопкой «Загрузить».
 *
 * Общий указатель в шапке виден с любого экрана, но здесь список нужен тоже:
 * человек только что выбрал файлы и смотрит именно сюда. Строки те же самые
 * (UploadTaskRow), состояние одно — расходиться нечему.
 */
export function UploadQueueList({ propertyId, kind }: { propertyId: string; kind: UploadKind }) {
  const { tasks, activeId, activeLoaded, activeTotal, activeSpeedBps } = usePropertyUploads(propertyId, kind);
  if (tasks.length === 0) return null;

  // Карточка объекта на тему ещё не переносилась, а строки очереди — уже
  // (`UploadTaskRow` рисуется классами эталона). Область темы открывается здесь:
  // без неё строки вышли бы голым текстом, молча (см. Rh2Scope.tsx).
  return (
    <Rh2Inline className="mb-3">
      <div className="list">
      {tasks.map((task) => {
        const active = task.id === activeId && task.status === "uploading";
        return (
          <UploadTaskRow
            key={task.id}
            task={task}
            active={active}
            percent={active && activeTotal > 0 ? Math.round((activeLoaded / activeTotal) * 100) : 0}
            loadedBytes={active ? activeLoaded : undefined}
            speedBps={active ? activeSpeedBps : undefined}
          />
        );
      })}
      </div>
    </Rh2Inline>
  );
}

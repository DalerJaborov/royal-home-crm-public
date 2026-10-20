import type { PropertyStageState, PropertyStatus } from "@royal-home/shared";
import { PROPERTY_STATUS_CLASSES, PROPERTY_STATUS_LABELS, STAGE_OWNER_LABELS } from "../lib/format";

/** Состояние этапа конвейера — считает сервер (api: lib/propertyPipeline.ts) и
 *  описывает @royal-home/shared, чтобы обе стороны держались одного набора полей. */
export type PropertyStage = PropertyStageState;

/**
 * Значок состояния объекта.
 *
 * У состояний конвейера подготовки рядом стоит ответственный и, если срок вышел,
 * красная отметка. Просрочку СЧИТАЕТ СЕРВЕР и присылает готовым признаком: сроки
 * живут в Настройках, и своя копия правила в интерфейсе однажды покрасила бы
 * список и карточку по-разному.
 */
export function StatusBadge({ status, stage }: { status: PropertyStatus; stage?: PropertyStage | null }) {
  const overdue = stage?.overdue === true;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span
        className={`inline-flex items-center gap-1.5 text-[15px] font-semibold rounded-badge px-2 py-0.5 ${
          overdue ? "text-red bg-red-bg" : PROPERTY_STATUS_CLASSES[status]
        }`}
      >
        <i className="w-[5px] h-[5px] rounded-full bg-current" />
        {PROPERTY_STATUS_LABELS[status]}
      </span>
      {stage?.inPipeline && stage.owner && (
        <span className="text-[13px] text-gray-500">
          {STAGE_OWNER_LABELS[stage.owner] ?? stage.owner}
          {overdue
            ? ` · просрочено на ${stage.daysInStage - (stage.limitDays ?? 0)} дн.`
            : stage.daysInStage > 0
              ? ` · ${stage.daysInStage} дн.`
              : ""}
        </span>
      )}
    </span>
  );
}

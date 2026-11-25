import { useState } from "react";
import type { RegistryChoice, RegistryProjectDto, RegistryProjectOption, RegistryPropertyResponse } from "@royal-home/shared";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useRegistryMatchPreview } from "../../hooks/useConstructionRegistry";
import { RegistryPicker, type RegistryFieldState } from "./RegistryPicker";

/**
 * «Застройщик и разрешение» в мастере нового объекта и в форме правки (25.11.2026). Как только у объекта есть точка,
 * спрашиваем сервер (match-preview), какой проект реестра у неё: уверены — подставляем, не уверены — догадка с
 * «проверьте», нет — пустое поле. Выбор сотрудника копится здесь и уходит вместе с сохранением объекта
 * (registryChoicePayload → поле `registry` запроса). Не трогал поле — решает автосвязь на сервере, как раньше.
 * У вторички поле свёрнуто: оно необязательное.
 */

/** Что сделал сотрудник в поле. null — ничего: решает автоматика. */
export type RegistryUserChoice = { kind: "project"; option: RegistryProjectOption } | { kind: "none" };

/** Выбор сотрудника → поле `registry` запроса создания или правки объекта. */
export function registryChoicePayload(choice: RegistryUserChoice | null): RegistryChoice | undefined {
  if (!choice) return undefined;
  return choice.kind === "none" ? { kind: "none" } : { kind: "project", projectId: choice.option.id };
}

/** Проект из ответа карточки → строка поля выбора. */
export function optionFromProject(project: RegistryProjectDto, developer: string, distanceM: number | null): RegistryProjectOption {
  return {
    id: project.id,
    title: project.title,
    developer,
    address: project.address,
    qaror: project.qaror,
    color: project.color,
    distanceM,
    sourceUrl: project.sourceUrl,
  };
}

export interface RegistryFieldProps {
  point: { lat: number; lng: number } | null;
  address: string;
  isNewBuilding: boolean;
  /** Форма правки: объект уже есть, его отвергнутые проекты не предлагаем. */
  propertyId?: string;
  /** Форма правки: сохранённая связь объекта (ответ карточки). */
  saved?: RegistryPropertyResponse;
  /** Форма правки: точку сдвинули — автоматическую связь показываем по новой точке. */
  pointChanged?: boolean;
  choice: RegistryUserChoice | null;
  onChoice: (choice: RegistryUserChoice | null) => void;
}

export function RegistryField({ point, address, isNewBuilding, propertyId, saved, pointChanged = false, choice, onChoice }: RegistryFieldProps) {
  const [expanded, setExpanded] = useState(false);
  // Адрес печатают по букве: ждём паузу, чтобы не спрашивать сервер на каждую.
  const debouncedAddress = useDebouncedValue(address, 600);
  const savedLink = saved?.link ?? null;
  const keepSaved = savedLink !== null && (savedLink.method === "MANUAL" || !pointChanged);
  const preview = useRegistryMatchPreview(
    { propertyId, lat: point?.lat ?? null, lng: point?.lng ?? null, address: debouncedAddress, isNewBuilding },
    point !== null && !keepSaved,
  );
  const data = preview.data;
  if (saved && !saved.enabled) return null;
  if (data && (!data.enabled || data.notLoaded)) return null;

  let state: RegistryFieldState = { kind: "empty" };
  if (choice?.kind === "project") state = { kind: "picked", option: choice.option };
  else if (choice?.kind === "none") state = { kind: "none" };
  else if (keepSaved && savedLink) {
    state = { kind: "linked", method: savedLink.method, option: optionFromProject(savedLink.project, savedLink.developer.name, savedLink.distanceM) };
  } else if (data?.best && data.level === "auto") state = { kind: "auto", option: data.best };
  else if (data?.best && data.level === "suggest") state = { kind: "guess", option: data.best };

  // Ни точки, ни выбора, ни сохранённой связи: подсказать, откуда возьмётся значение.
  if (!point && state.kind === "empty") {
    return (
      <p className="quiet" data-testid="registry-field-no-point">
        <span className="txt">Застройщик и разрешение определятся сами, когда на карте будет точка.</span>
      </p>
    );
  }

  const collapsible = !isNewBuilding && !choice && state.kind !== "auto" && state.kind !== "linked";
  if (collapsible && !expanded) {
    return (
      <button type="button" className="lnk" data-testid="registry-field-expand" aria-expanded={false} onClick={() => setExpanded(true)}>
        Застройщик и разрешение (необязательно)
      </button>
    );
  }

  const nearby = data ? [...(data.best ? [data.best] : []), ...data.alternatives] : [];
  return (
    <>
      {preview.isError && !data && (
        <p className="quiet" role="status" data-testid="registry-field-error">
          <span className="txt">Не удалось определить застройщика по точке. Выберите проект в поле ниже или оставьте пустым.</span>
        </p>
      )}
      <RegistryPicker
      state={state}
      updatedAt={data?.updatedAt ?? saved?.updatedAt ?? null}
      point={point}
      nearby={nearby}
      onPick={(option) => onChoice({ kind: "project", option })}
      onNone={() => onChoice({ kind: "none" })}
      />
    </>
  );
}

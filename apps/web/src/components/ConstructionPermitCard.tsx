import { useState, type ReactNode } from "react";
import {
  REGISTRY_COLOR_LABEL,
  registrySourceCaption,
  type RegistryColor,
  type RegistryDeveloperDto,
  type RegistryProjectDto,
  type RegistryPropertyResponse,
} from "@royal-home/shared";
import {
  useLinkRegistryProject,
  useMarkNotInRegistry,
  usePropertyRegistry,
  useUnlinkRegistryProject,
} from "../hooks/useConstructionRegistry";
import { RegistryPicker, type RegistryFieldState } from "./registry/RegistryPicker";
import { optionFromProject } from "./registry/RegistryField";
import { Card } from "./rh2/Card";
import { type ChipTone } from "./rh2/Chip";
import { ConfirmDialog } from "./ConfirmDialog";
import { MutationError } from "./MutationError";

/**
 * «РАЗРЕШЕНИЕ НА СТРОИТЕЛЬСТВО» в карточке объекта (реестр memor.pro, 20.11.2026).
 * Данные только для сотрудников: клиенту их показывает агент своими словами, на сайт и в бота они не идут.
 * Подписи цветов и предупреждения — packages/shared (REGISTRY_COLOR_LABEL), здесь своих текстов про цвет нет.
 * Рубильник выключен или реестр не загрузился: блока нет вовсе, карточка объекта работает как раньше.
 */

const COLOR_TONE: Record<RegistryColor, ChipTone> = { green: "ok", yellow: "warn", red: "crit" };

function DeveloperBlock({ developer }: { developer: RegistryDeveloperDto }) {
  const { rating } = developer;
  const verdict =
    rating.letter === null ? "Мало данных" : `Оценка ${rating.letter}${rating.score !== null ? `, ${rating.score} из 100` : ""}`;
  return (
    <div data-testid="permit-developer">
      <div className="row rh-row">
        <div className="t">
          {/* Имя застройщика уже в поле выше; здесь только его оценка по реестру. */}
          <b>Оценка застройщика</b>
          <span data-testid="permit-rating">{verdict}</span>
        </div>
      </div>
      {rating.reasons.length > 0 && (
        <details className="quiet" data-testid="permit-reasons">
          <summary className="lnk">Почему такая оценка</summary>
          <ul>
            {rating.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ProjectFacts({ project }: { project: RegistryProjectDto }) {
  return (
    <>
      {project.blocks.length > 0 && (
        <div className="row rh-row" data-testid="permit-blocks">
          <div className="t">
            <b>Блоки с разрешением</b>
            <span>{project.blocks.join(", ")}</span>
          </div>
        </div>
      )}
      {project.floors != null && (
        <div className="row rh-row">
          <div className="t">
            <b>Этажность</b>
            <span>{project.floors}</span>
          </div>
        </div>
      )}
      {project.documents.length > 0 && (
        <div className="row rh-row" data-testid="permit-docs">
          <div className="t">
            <b>Документы</b>
            <ul>
              {project.documents.map((doc) => (
                <li key={doc.name}>{`${doc.ready ? "✓" : "Нет:"} ${doc.name}`}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

export interface ConstructionPermitViewProps {
  data: RegistryPropertyResponse;
  busy?: boolean;
  /** Точка объекта: в поиске по реестру ближние проекты выше. */
  point?: { lat: number; lng: number } | null;
  /** Выбран проект в поле (ручная связь). */
  onPick?: (projectId: string) => void;
  /** «Нет в реестре / не новостройка». */
  onNone?: () => void;
  onUnlink?: () => void;
  /** Ошибки последних действий (например, «нет права менять привязку»). */
  children?: ReactNode;
}

/**
 * Только разметка, без запросов карточки: её и проверяет тест. Вместо вопроса «Это ваш дом? Это он / Не он» (владелец
 * 25.11.2026: «лишний») одно поле «Застройщик и разрешение»: связь есть — она и «Изменить»; связи нет — лучшая догадка
 * с «проверьте» или пустое поле поиска по всему реестру.
 */
export function ConstructionPermitView({ data, busy = false, point = null, onPick, onNone, onUnlink, children }: ConstructionPermitViewProps) {
  if (!data.enabled) return null;
  // Реестр ещё ни разу не загружался: честно говорим об этом, а не «не найден».
  if (data.notLoaded) {
    return (
      <Card tight title="Разрешение на строительство" data-testid="construction-permit">
        <div className="quiet" data-testid="permit-not-loaded">
          <span className="dot" />
          <span className="txt">Реестр строек ещё не загружен. Проверка заработает после первого обновления.</span>
        </div>
      </Card>
    );
  }
  // У вторички «в реестре не найден» ничего не значит: если показывать нечего, блок не рисуем.
  if (!data.link && !data.noPoint && data.suggestions.length === 0 && !data.notFound) return null;
  const { link } = data;
  const color = link?.project.color;
  const label = color ? REGISTRY_COLOR_LABEL[color] : null;
  const guess = !link ? data.suggestions[0] : undefined;
  const state: RegistryFieldState = link
    ? { kind: "linked", method: link.method, option: optionFromProject(link.project, link.developer.name, link.distanceM) }
    : guess
      ? { kind: "guess", option: optionFromProject(guess.project, guess.developer.name, guess.distanceM) }
      : { kind: "empty" };
  const nearby = data.suggestions.slice(0, 3).map((s) => optionFromProject(s.project, s.developer.name, s.distanceM));

  return (
    <Card tight title="Разрешение на строительство" data-testid="construction-permit">
      {!link && data.noPoint && (
        <div className="quiet" data-testid="permit-no-point">
          <span className="dot" />
          <span className="txt">У объекта нет точки на карте, реестр сопоставить не с чем. Укажите адрес или точку, или выберите проект ниже.</span>
        </div>
      )}

      {!link && !data.noPoint && data.suggestions.length === 0 && data.notFound && (
        <div className="quiet" data-testid="permit-not-found">
          <span className="dot warn" />
          <span className="txt">
            В реестре не найден. Если это новостройка, это повод запросить документы на разрешение у застройщика.
          </span>
        </div>
      )}

      <RegistryPicker
        state={state}
        updatedAt={data.updatedAt}
        point={point}
        nearby={nearby}
        busy={busy}
        label={null}
        // «Нет в реестре» — только когда есть что отвергать: точка и проекты рядом или связь (ревью PR #441).
        canMarkNone={!data.noPoint && (data.suggestions.length > 0 || link !== null)}
        onPick={(option) => onPick?.(option.id)}
        onNone={() => onNone?.()}
      />

      {link && label && color && (
        <>
          {label.warning && (
            <div className="quiet" data-testid="permit-warning">
              <span className={`dot ${COLOR_TONE[color]}`} />
              <span className="txt">{label.warning}</span>
            </div>
          )}
          <ProjectFacts project={link.project} />
          <DeveloperBlock developer={link.developer} />
          <div className="quiet">
            <a className="lnk" href={link.project.sourceUrl} target="_blank" rel="noopener noreferrer">
              Открыть в реестре
            </a>
            <span className="spacer" />
            {onUnlink && (
              <button type="button" className="lnk" disabled={busy} onClick={onUnlink}>
                Отвязать
              </button>
            )}
          </div>
        </>
      )}

      {children}

      <div className="quiet" data-testid="permit-source">
        <span className="txt" style={{ fontSize: "var(--fs-13)" }}>
          {registrySourceCaption(data.updatedAt)}
        </span>
      </div>
    </Card>
  );
}

/** Блок для карточки объекта. `propertyId` — короткий номер (/properties/1042) или uuid. */
export function ConstructionPermitCard({ propertyId, point = null }: { propertyId: string | number; point?: { lat: number; lng: number } | null }) {
  const { data, isError } = usePropertyRegistry(propertyId);
  const link = useLinkRegistryProject(propertyId);
  const none = useMarkNotInRegistry(propertyId);
  const unlink = useUnlinkRegistryProject(propertyId);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (isError || !data || !data.enabled) return null;
  const busy = link.isPending || none.isPending || unlink.isPending;

  return (
    <>
      <ConstructionPermitView
        data={data}
        busy={busy}
        point={point}
        onPick={(id) => link.mutate(id)}
        onNone={() => none.mutate()}
        onUnlink={() => setConfirmUnlink(true)}
      >
        <MutationError mutation={link} fallback="Не удалось связать с проектом реестра" variant="rh2" />
        <MutationError mutation={none} fallback="Не удалось отметить «нет в реестре»" variant="rh2" />
        <MutationError mutation={unlink} fallback="Не удалось отвязать проект" variant="rh2" />
      </ConstructionPermitView>
      {confirmUnlink && (
        <ConfirmDialog
          title="Отвязать от проекта реестра?"
          description="Объект перестанет показывать статус этого проекта. Связать заново можно в любой момент."
          confirmLabel="Отвязать"
          danger={false}
          onConfirm={() => {
            setConfirmUnlink(false);
            unlink.mutate();
          }}
          onCancel={() => setConfirmUnlink(false)}
        />
      )}
    </>
  );
}
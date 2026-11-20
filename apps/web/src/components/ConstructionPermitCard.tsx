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
  usePropertyRegistry,
  useRejectRegistryProject,
  useUnlinkRegistryProject,
} from "../hooks/useConstructionRegistry";
import { Card } from "./rh2/Card";
import { Chip, type ChipTone } from "./rh2/Chip";
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
          <b>Застройщик: {developer.name}</b>
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
  onLink?: (projectId: string) => void;
  onReject?: (projectId: string) => void;
  onUnlink?: () => void;
  /** Ошибки последних действий (например, «нет права менять привязку»). */
  children?: ReactNode;
}

/** Только разметка, без запросов: её и проверяет тест. */
export function ConstructionPermitView({ data, busy = false, onLink, onReject, onUnlink, children }: ConstructionPermitViewProps) {
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

  return (
    <Card tight title="Разрешение на строительство" data-testid="construction-permit">
      {link && label && color && (
        <>
          <div className="row rh-row">
            <div className="t">
              <b>{link.project.title}</b>
              <span>{label.hint}</span>
            </div>
            <Chip tone={COLOR_TONE[color]} data-testid="permit-status">
              {label.title}
            </Chip>
          </div>
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

      {!link && data.noPoint && (
        <div className="quiet" data-testid="permit-no-point">
          <span className="dot" />
          <span className="txt">У объекта нет точки на карте, реестр сопоставить нечем. Укажите адрес или точку, и проверка заработает.</span>
        </div>
      )}

      {!link && !data.noPoint && data.suggestions.length > 0 && (
        <div data-testid="permit-suggestions">
          <div className="quiet">
            <span className="dot" />
            <span className="txt">Рядом с объектом нашлись стройки из реестра. Это ваш дом?</span>
          </div>
          {data.suggestions.slice(0, 3).map((s) => (
            <div className="row rh-row" key={s.project.id} data-testid="permit-suggestion" style={{ flexWrap: "wrap", rowGap: 8 }}>
              {/* На телефоне название на всю ширину, а статус и кнопки под ним: иначе текст сжимается в столбик. */}
              <div className="t" style={{ flex: "1 1 100%", minWidth: 0 }}>
                <b>{s.project.title}</b>
                <span>
                  {s.developer.name}
                  {s.distanceM != null ? `, ${Math.round(s.distanceM)} м от точки объекта` : ""}
                </span>
              </div>
              <Chip tone={COLOR_TONE[s.project.color]}>{REGISTRY_COLOR_LABEL[s.project.color].title}</Chip>
              <div className="act">
                <button type="button" className="pill sm" disabled={busy} onClick={() => onLink?.(s.project.id)}>
                  Это он
                </button>
                <button type="button" className="pill sm ghost" disabled={busy} onClick={() => onReject?.(s.project.id)}>
                  Не он
                </button>
              </div>
            </div>
          ))}
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
export function ConstructionPermitCard({ propertyId }: { propertyId: string | number }) {
  const { data, isError } = usePropertyRegistry(propertyId);
  const link = useLinkRegistryProject(propertyId);
  const reject = useRejectRegistryProject(propertyId);
  const unlink = useUnlinkRegistryProject(propertyId);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  if (isError || !data || !data.enabled) return null;
  const busy = link.isPending || reject.isPending || unlink.isPending;

  return (
    <>
      <ConstructionPermitView
        data={data}
        busy={busy}
        onLink={(id) => link.mutate(id)}
        onReject={(id) => reject.mutate(id)}
        onUnlink={() => setConfirmUnlink(true)}
      >
        <MutationError mutation={link} fallback="Не удалось связать с проектом реестра" variant="rh2" />
        <MutationError mutation={reject} fallback="Не удалось отклонить предложение" variant="rh2" />
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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PROPERTY_CHANGE_KIND_HINTS,
  PROPERTY_CHANGE_KIND_LABELS,
  PROPERTY_CHANGE_STATUS_LABELS,
  VIDEO_REMAKE_REASONS,
  VIDEO_REMAKE_REASONS_REQUIRING_COMMENT,
  VIDEO_REMAKE_REASON_LABELS,
  type CreatePropertyChangeRequestInput,
  type PropertyChangeKind,
  type PropertyChangeRequestDto,
  type PropertyChangeStatus,
  type VideoRemakeReason,
} from "@royal-home/shared";
import {
  useApprovePropertyChangeRequest,
  useCancelPropertyChangeRequest,
  useCreatePropertyChangeRequest,
  usePropertyChangeRequests,
  useRejectPropertyChangeRequest,
} from "../hooks/usePropertyChangeRequests";
import { useDistricts } from "../hooks/useDistricts";
import { newIdempotencyKey } from "../lib/api";
import { formatMoney, relativeTime } from "../lib/format";
import {
  CARD_DATA_FIELDS,
  CHANGE_KIND_BUTTONS,
  buildCardDataBody,
  buildOtherBody,
  buildPriceChangeBody,
  buildRemakeBody,
  buildUnpublishBody,
  cardDataInitial,
  changeResultView,
  channelLabel,
  consequenceLine,
  describeChangeRequest,
  kindDisabledReason,
  type CardDataFieldKey,
  type ChangeRequestMode,
  type ChangeResultView,
} from "../lib/propertyChangeRequestView";
import { ConfirmDialog } from "./ConfirmDialog";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { toast } from "../store/toast";
import type { Property } from "../types";

/**
 * «ИЗМЕНИТЬ ПОСЛЕ ПУБЛИКАЦИИ» (07.10.2026, решение владельца).
 *
 * После публикации агент в карточке ничего не меняет сам: он нажимает готовую кнопку
 * («Цена изменилась», «Перемонтировать ролик»…), а директор или админ решают заявку,
 * и CRM делает то, что умеет через API сетей. Один компонент на ПК и телефон; два режима:
 *  — «автор» (у сотрудника есть `properties.requestChange`, права решать нет): готовые
 *    кнопки и «Мои заявки по объекту»;
 *  — «решатель» (`properties.delete`): заявки по объекту, ждущие решения, сверху;
 *    принять или отклонить; итог после «Принять» остаётся в карточке заявки.
 * Режим считает `changeRequestMode` (lib/propertyChangeRequestView.ts) — компонент
 * получает его готовым, чтобы условие видимости жило в одном месте и проверялось тестом.
 */

const STATUS_CHIP: Record<PropertyChangeStatus, string> = {
  PENDING: "chip warn sm",
  APPROVED: "chip ok sm",
  REJECTED: "chip crit sm",
  CANCELLED: "chip sm",
  FAILED: "chip crit sm",
};

export function PropertyChangeRequestCard({
  property,
  mode,
  highlightId,
}: {
  property: Property;
  mode: ChangeRequestMode;
  /** `?changeRequest=<id>` из уведомления директору: прокрутить к заявке и подсветить. */
  highlightId?: string | null;
}) {
  if (!mode || property.offSite) return null;
  return <ChangeRequestsPanel property={property} mode={mode} highlightId={highlightId ?? null} />;
}

function ChangeRequestsPanel({
  property,
  mode,
  highlightId,
}: {
  property: Property;
  mode: Exclude<ChangeRequestMode, null>;
  highlightId: string | null;
}) {
  const { data, isLoading, isError, refetch } = usePropertyChangeRequests(property.id);
  const items = useMemo(() => data?.items ?? [], [data]);
  const [formKind, setFormKind] = useState<PropertyChangeKind | null>(null);

  // Ждущие решения — сверху, остальные по времени (свежие выше); сервер уже отдаёт по убыванию даты.
  const sorted = useMemo(
    () => [...items].sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING")),
    [items]
  );

  // Директору без единой заявки показывать пустой блок незачем — «Ролик и соцсети» выше
  // и так делает всё напрямую; но пока грузим или при ошибке — честно говорим об этом.
  if (mode === "decider" && !isLoading && !isError && items.length === 0) return null;

  return (
    <section className="card" id="property-change-requests">
      <div className="sec-h stack">
        <h2>{mode === "author" ? "Изменить после публикации" : "Заявки на изменение"}</h2>
        {mode === "author" && (
          <span className="note">Сами менять опубликованную карточку нельзя — отправьте заявку, директор решит</span>
        )}
        {mode === "decider" && <span className="note">Принять — и CRM сама обновит то, что умеет</span>}
      </div>

      {mode === "author" && (
        <KindTiles property={property} onPick={setFormKind} />
      )}

      {mode === "author" && <div className="sec-t">Мои заявки по объекту</div>}

      {isLoading && (
        <div className="state">
          <span className="sk av" />
          <span className="sk w28" />
          <span className="sk w22" /> Загружаем заявки
        </div>
      )}
      {isError && (
        <div className="state err" role="alert">
          <span className="dot crit" />
          Не удалось загрузить заявки — это не значит, что их нет.{" "}
          <button type="button" className="lnk" onClick={() => void refetch()}>
            Повторить
          </button>
        </div>
      )}
      {!isLoading && !isError && sorted.length === 0 && mode === "author" && (
        <p className="quiet">
          <span className="dot" />
          <span className="txt">Заявок по этому объекту пока нет.</span>
        </p>
      )}

      {sorted.length > 0 && (
        <div className="list">
          {sorted.map((r) => (
            <RequestRow key={r.id} request={r} property={property} mode={mode} highlighted={r.id === highlightId} />
          ))}
        </div>
      )}

      {formKind && <ChangeRequestFormSheet key={formKind} kind={formKind} property={property} onClose={() => setFormKind(null)} />}
    </section>
  );
}

// ───────────────────────── готовые кнопки ─────────────────────────

function KindTiles({ property, onPick }: { property: Property; onPick: (kind: PropertyChangeKind) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--s3, 12px)",
        marginTop: "var(--s3, 12px)",
      }}
    >
      {CHANGE_KIND_BUTTONS.map((kind) => {
        const disabledReason = kindDisabledReason(kind, property.publishedChannels ?? []);
        return (
          <button
            key={kind}
            type="button"
            disabled={disabledReason !== null}
            onClick={() => onPick(kind)}
            data-kind={kind}
            style={{
              textAlign: "left",
              minHeight: 64,
              padding: "12px 14px",
              borderRadius: 14,
              border: "1px solid var(--line, rgba(0,0,0,.08))",
              background: "var(--soft, rgba(0,0,0,.04))",
              color: "var(--ink, inherit)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              opacity: disabledReason ? 0.6 : 1,
              cursor: disabledReason ? "not-allowed" : "pointer",
            }}
          >
            <b style={{ fontSize: "var(--fs-15, 15px)" }}>{PROPERTY_CHANGE_KIND_LABELS[kind]}</b>
            <span style={{ fontSize: "var(--fs-13, 13px)", color: "var(--muted, inherit)" }}>
              {disabledReason ?? PROPERTY_CHANGE_KIND_HINTS[kind]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── форма заявки ─────────────────────────

function ChangeRequestFormSheet({
  kind,
  property,
  onClose,
}: {
  kind: PropertyChangeKind;
  property: Property;
  onClose: () => void;
}) {
  const create = useCreatePropertyChangeRequest(property.id);
  // Один ключ на открытое окно: повторное нажатие после обрыва связи не заведёт вторую заявку.
  const idemKey = useRef<string>(newIdempotencyKey());
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  // PRICE_CHANGE
  const [newPrice, setNewPrice] = useState("");
  const [remake, setRemake] = useState(false);
  // CARD_DATA
  const current = useMemo(() => cardDataInitial(property), [property]);
  const [edited, setEdited] = useState<Record<CardDataFieldKey, string>>(current);
  const { data: districts } = useDistricts();
  // REMAKE_VIDEO
  const [reason, setReason] = useState<VideoRemakeReason | null>(null);
  const [removeFromSocial, setRemoveFromSocial] = useState(true);
  // UNPUBLISH
  const available = property.publishedChannels ?? [];
  const [selected, setSelected] = useState<string[]>(available);
  // OTHER
  const [text, setText] = useState("");

  const reasonNeedsComment = reason !== null && VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(reason);

  async function submit() {
    let built;
    switch (kind) {
      case "PRICE_CHANGE":
        built = buildPriceChangeBody({ newPrice, remake, comment });
        break;
      case "CARD_DATA":
        built = buildCardDataBody({ current, edited, remake, comment });
        break;
      case "REMAKE_VIDEO":
        built = buildRemakeBody({ reason, removeFromSocial, comment });
        break;
      case "UNPUBLISH":
        built = buildUnpublishBody({ selected, available, comment });
        break;
      case "OTHER":
        built = buildOtherBody({ text });
        break;
    }
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    try {
      await create.mutateAsync({ body: built.body as CreatePropertyChangeRequestInput, idempotencyKey: idemKey.current });
      toast.success("Заявка отправлена директору");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить заявку");
    }
  }

  return (
    <Rh2Sheet
      title={PROPERTY_CHANGE_KIND_LABELS[kind]}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="pill ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="pill" disabled={create.isPending}>
            {create.isPending ? "Отправляем…" : "Отправить заявку"}
          </button>
        </>
      }
    >
      <p className="state">{PROPERTY_CHANGE_KIND_HINTS[kind]}</p>

      {kind === "PRICE_CHANGE" && (
        <>
          <label className="fld">
            <span className="lab">
              Новая цена, {property.currency === "USD" ? "$" : "сомони"} (сейчас {formatMoney(property.price, property.currency)})
            </span>
            <input
              inputMode="decimal"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              placeholder="Например: 89000"
              autoFocus
            />
          </label>
          <RemakeSwitch checked={remake} onChange={setRemake} />
        </>
      )}

      {kind === "CARD_DATA" && (
        <>
          <p className="quiet">
            <span className="dot" />
            <span className="txt">Поправьте только то, что изменилось, — остальные поля уйдут без изменений.</span>
          </p>
          <div className="fgrid">
            {CARD_DATA_FIELDS.map((f) => (
              <label className="fld" key={f.key}>
                <span className="lab">{f.label}</span>
                {f.kind === "district" ? (
                  <select value={edited.districtId} onChange={(e) => setEdited((p) => ({ ...p, districtId: e.target.value }))}>
                    {edited.districtId === "" && <option value="">Не указан</option>}
                    {(districts ?? []).map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    inputMode={f.kind === "text" ? "text" : "decimal"}
                    value={edited[f.key]}
                    onChange={(e) => setEdited((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
          <RemakeSwitch checked={remake} onChange={setRemake} />
        </>
      )}

      {kind === "REMAKE_VIDEO" && (
        <>
          <div className="sec-t">Причина</div>
          {VIDEO_REMAKE_REASONS.map((r) => (
            <label key={r} className="chk">
              <input type="radio" name="change-remake-reason" checked={reason === r} onChange={() => setReason(r)} />
              {VIDEO_REMAKE_REASON_LABELS[r]}
            </label>
          ))}
          <label className="chk">
            <input type="checkbox" checked={removeFromSocial} onChange={(e) => setRemoveFromSocial(e.target.checked)} />
            Сначала убрать старый ролик из соцсетей
          </label>
        </>
      )}

      {kind === "UNPUBLISH" && (
        <>
          <div className="sec-t">Откуда убрать</div>
          {available.map((channel) => (
            <label key={channel} className="chk">
              <input
                type="checkbox"
                checked={selected.includes(channel)}
                onChange={() =>
                  setSelected((prev) => (prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel]))
                }
              />
              {channelLabel(channel)}
            </label>
          ))}
        </>
      )}

      {kind === "OTHER" && (
        <label className="fld">
          <span className="lab">Что нужно изменить (от 10 символов)</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} autoFocus />
        </label>
      )}

      {kind !== "OTHER" && (
        <label className="fld" style={{ marginTop: "var(--s4)" }}>
          <span className="lab">
            Комментарий {reasonNeedsComment ? "(обязателен для этой причины — что именно не так)" : "(необязательно)"}
          </span>
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </label>
      )}

      {error && (
        <p className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}
    </Rh2Sheet>
  );
}

function RemakeSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <>
      <label className="chk">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Перемонтировать ролик с новой ценой и данными
      </label>
      <p className="quiet">
        <span className="dot" />
        <span className="txt">Цена и данные в кадре видео меняются только перемонтажом.</span>
      </p>
    </>
  );
}

// ───────────────────────── строка заявки ─────────────────────────

function RequestRow({
  request,
  property,
  mode,
  highlighted,
}: {
  request: PropertyChangeRequestDto;
  property: Property;
  mode: Exclude<ChangeRequestMode, null>;
  highlighted: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const approve = useApprovePropertyChangeRequest();
  const reject = useRejectPropertyChangeRequest();
  const cancel = useCancelPropertyChangeRequest();
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  const pending = request.status === "PENDING";
  const result = changeResultView(request);

  async function doApprove() {
    setActionError(null);
    try {
      await approve.mutateAsync({ id: request.id });
      setConfirming(false);
    } catch (err) {
      setConfirming(false);
      setActionError(err instanceof Error ? err.message : "Не удалось принять заявку");
    }
  }

  async function doReject(note: string) {
    setActionError(null);
    try {
      await reject.mutateAsync({ id: request.id, note });
      setRejecting(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Не удалось отклонить заявку");
    }
  }

  async function doCancel() {
    setActionError(null);
    try {
      await cancel.mutateAsync({ id: request.id });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Не удалось отозвать заявку");
    }
  }

  return (
    <div
      className="row"
      id={`change-request-${request.id}`}
      ref={ref}
      data-status={request.status}
      style={highlighted ? { outline: "2px solid var(--pill, currentColor)", outlineOffset: 2, borderRadius: 14 } : undefined}
    >
      <div className="t">
        <b>
          {PROPERTY_CHANGE_KIND_LABELS[request.kind]}{" "}
          <span className={STATUS_CHIP[request.status]}>{PROPERTY_CHANGE_STATUS_LABELS[request.status]}</span>
        </b>
        <span>{describeChangeRequest(request, property)}</span>
        <span>
          {mode === "decider" ? `Просит ${request.author.fullName}, ` : ""}
          {relativeTime(request.createdAt)}
        </span>
        {request.comment && <span>«{request.comment}»</span>}

        {pending && mode === "decider" && (
          <p className="quiet">
            <span className="dot" />
            <span className="txt">После «Принять»: {consequenceLine(request)}</span>
          </p>
        )}

        {request.status === "REJECTED" && (
          <p className="quiet crit">
            <span className="dot crit" />
            <span className="txt">
              Отклонено{request.decidedBy ? ` (${request.decidedBy.fullName})` : ""}
              {request.decisionNote ? `: ${request.decisionNote}` : ""}
            </span>
          </p>
        )}
        {request.status === "APPROVED" && request.decisionNote && (
          <p className="quiet">
            <span className="dot" />
            <span className="txt">Комментарий директора: {request.decisionNote}</span>
          </p>
        )}

        {result && <ResultBlock result={result} mode={mode} />}

        {actionError && (
          <p className="state err" role="alert">
            <span className="dot crit" />
            {actionError}
          </p>
        )}
      </div>

      <div className="act">
        {pending && mode === "decider" && (
          <>
            <button className="pill sm" type="button" disabled={approve.isPending} onClick={() => setConfirming(true)}>
              Принять
            </button>
            <button className="pill ghost sm" type="button" onClick={() => setRejecting(true)}>
              Отклонить
            </button>
          </>
        )}
        {pending && mode === "author" && (
          <button className="pill ghost sm" type="button" disabled={cancel.isPending} onClick={() => void doCancel()}>
            Отозвать
          </button>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Принять заявку?"
          description={`${describeChangeRequest(request, property)}. ${consequenceLine(request)}`}
          confirmLabel={approve.isPending ? "Выполняем…" : "Принять и выполнить"}
          danger={false}
          confirmDisabled={approve.isPending}
          onConfirm={() => void doApprove()}
          onCancel={() => setConfirming(false)}
        />
      )}
      {rejecting && (
        <RejectChangeSheet
          pending={reject.isPending}
          error={actionError}
          onCancel={() => {
            setRejecting(false);
            setActionError(null);
          }}
          onSubmit={(note) => void doReject(note)}
        />
      )}
    </div>
  );
}

/**
 * Итог после «Принять»: сделанное галочками, остаток руками — предупреждением (а не
 * строкой в журнале), сбой — красным с подсказкой, что директор может сделать это сам.
 */
export function ResultBlock({ result, mode }: { result: ChangeResultView; mode: Exclude<ChangeRequestMode, null> }) {
  return (
    <>
      {result.failed && (
        <p className="state err" role="alert">
          <span className="dot crit" />
          {result.failed}
          {mode === "decider" && " Можно сделать это самому: кнопки в блоке «Ролик и соцсети» этой карточки."}
        </p>
      )}
      {result.applied.map((line, i) => (
        <p key={i} className="quiet ok">
          <span className="dot ok" />
          <span className="txt">✓ {line}</span>
        </p>
      ))}
      {result.remakeQueued && (
        <p className="quiet ok">
          <span className="dot ok" />
          <span className="txt">✓ Ролик отправлен на перемонтаж</span>
        </p>
      )}
      {result.manual.length > 0 && (
        <div className="quiet warn" role="status">
          <span className="dot warn" />
          <div className="txt">
            <b>{mode === "author" ? "Придётся сделать руками" : "Руками"}:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {result.manual.map((m, i) => (
                <li key={i}>
                  {channelLabel(m.channel)}: {m.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

function RejectChangeSheet({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const tooShort = note.trim().length < 3;
  return (
    <Rh2Sheet
      onClose={onCancel}
      title="Отклонить заявку"
      onSubmit={() => {
        if (!tooShort) onSubmit(note.trim());
      }}
      footer={
        <>
          <button className="pill ghost" type="button" onClick={onCancel}>
            Отмена
          </button>
          <button className="pill" type="submit" disabled={tooShort || pending}>
            Отправить отказ
          </button>
        </>
      }
    >
      <p className="state">Причину увидит агент, который просил об изменении.</p>
      <div className={tooShort ? "fld bad" : "fld"} style={{ marginTop: 16 }}>
        <span className="lab">Почему заявка отклонена</span>
        <textarea autoFocus rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="msg">{error ?? "Без причины отказ не уйдёт."}</span>
      </div>
    </Rh2Sheet>
  );
}

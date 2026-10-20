import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PROPERTY_TYPE_LABELS,
  propertyFieldShown,
  type PropertyDraftView,
  type PropertyType,
} from "@royal-home/shared";
import { Film, Image as ImageIcon } from "lucide-react";
import type { District } from "../../types";
import { draftDaysLeft, draftMediaCounts, formatDraftSavedRelative } from "../../hooks/usePropertyDraft";
import { useClient } from "../../hooks/useClients";
import { useSellerObject } from "../../hooks/useSellerObject";
import { useAuthStore } from "../../store/auth";
import { readAllDraftFiles } from "../../lib/draftUploadStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { useDuplicateAddress } from "./useDuplicateAddress";
import { DuplicateAddressWarning } from "./DuplicateAddressWarning";
import {
  EMPTY_WIZARD_VALUES,
  firstIncompleteStep,
  incompleteFieldMessages,
  needsLandArea,
  needsRooms,
  stepIndexOf,
  type WizardValues,
} from "./types";

export type OfferedDraft =
  | { source: "server"; draft: PropertyDraftView }
  | { source: "local"; values: WizardValues };

/** Сколько снимков черновика показать плитками — один ряд из трёх и ещё один. */
const PREVIEW_TILES = 6;

/**
 * ПЕРВЫЙ ЭКРАН МАСТЕРА, КОГДА ЕСТЬ ЧЕРНОВИК (владелец 21.09.2026: «на первый
 * экран мастера, если есть черновик; если нет — первым окном выбор клиента»,
 * и следом: «дизайн уродский, сделай как сам мастер»).
 *
 * Собран из тех же деталей, что шаги мастера, а не отдельной плашкой: плитки
 * снимков — как на шаге «Фото и видео» (`.tiles`/`.tile`), строки «что уже
 * заполнено» — как на шаге «Проверка» (`.rev`/`.r`). Показываем только то, что
 * реально лежит в черновике: пустые поля агент увидит, когда продолжит.
 *
 * Шаги и добавление файлов недоступны, пока агент не ответил: «Начать заново»
 * удаляет черновик вместе с файлами, и файл, добавленный до ответа, ушёл бы туда же.
 *
 * ВТОРОЙ ЗАХОД (21.09.2026, владелец: «покажи, чего не хватает, и веди сразу
 * туда»). Экран больше не просто показывает, что заполнено — он ещё:
 *  1) считает чего не хватает теми же правилами, что validateStep/validateAll
 *     (firstIncompleteStep/incompleteFieldMessages в types.ts — второй раз не
 *     выдумываются);
 *  2) «Продолжить» и клик по строке сводки ведут СРАЗУ на нужный шаг (onGoTo),
 *     а не на сохранённый шаг/0;
 *  3) предупреждают о дублях — у продавца уже есть объект (useSellerObject) и
 *     совпадение по адресу (useDuplicateAddress, тот же хук, что и на шаге «Где»).
 */
export function DraftGate({
  offer,
  districts,
  requireIntakeAgent,
  onClose,
  onGoTo,
  onRestart,
  restartPending = false,
  restartError = null,
}: {
  offer: OfferedDraft;
  districts: District[];
  /** Руководителю сервер не подставляет интейкера сам — влияет на то, каких
   *  полей не хватает (см. validateStep("seller", ...) в types.ts). */
  requireIntakeAgent: boolean;
  onClose: () => void;
  /** Принять черновик и сразу перейти на конкретный шаг — зовут и кнопка
   *  «Продолжить» (сама решает, куда вести — firstIncompleteStep), и клик по
   *  строке сводки (ведёт на шаг именно этого поля). */
  onGoTo: (step: number) => void;
  onRestart: () => void;
  /** «Начать заново» выполняется (удаляется прежний черновик): кнопки заблокированы. */
  restartPending?: boolean;
  /** Прежний черновик удалить не удалось: причина под кнопками, можно повторить. */
  restartError?: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const values: Partial<WizardValues> =
    offer.source === "server" ? ((offer.draft.values ?? {}) as Partial<WizardValues>) : offer.values;
  const full: WizardValues = { ...EMPTY_WIZARD_VALUES, ...values };
  const media = offer.source === "server" ? offer.draft.media : [];
  const counts = offer.source === "server" ? draftMediaCounts(offer.draft) : { photos: 0, videos: 0 };
  const savedLabel = offer.source === "server" ? formatDraftSavedRelative(offer.draft) : "Сохранён в этом браузере";
  const daysLeft = offer.source === "server" ? draftDaysLeft(offer.draft) : null;
  const tiles = media.slice(0, PREVIEW_TILES);
  const hiddenCount = media.length - tiles.length;

  // НЕДОГРУЖЕННЫЕ ФАЙЛЫ (пункт 5 задания) — что лежит в IndexedDB этого агента
  // и ещё не READY на сервере, БЕЗ запуска очереди отправки (draftUploads.ts
  // тут нарочно не зовём — очередь стартует только после «Продолжить», как и
  // раньше, докблок PropertyWizard.tsx про блокирующий гейт).
  const agentId = useAuthStore((s) => s.agent?.id);
  const [pendingLocal, setPendingLocal] = useState({ photos: 0, videos: 0 });
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const readyKeys = new Set(
      offer.source === "server" ? offer.draft.media.filter((m) => m.status === "READY").map((m) => m.uploadKey) : []
    );
    readAllDraftFiles(agentId)
      .then((stored) => {
        if (cancelled) return;
        const rest = stored.filter((f) => !readyKeys.has(f.uploadKey));
        setPendingLocal({
          photos: rest.filter((f) => f.kind === "photo").length,
          videos: rest.filter((f) => f.kind === "video").length,
        });
      })
      .catch(() => {
        /* приватный режим/квота — строку просто не покажем */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, offer]);
  const pendingCount = pendingLocal.photos + pendingLocal.videos;

  // ДУБЛЬ 1 — у выбранного продавца уже есть объект(ы) в CRM (пункт 6а).
  const sellerObject = useSellerObject(full.sellerClientId || null, { enabled: !!full.sellerClientId });
  const sellerProperties = sellerObject.data?.properties ?? [];

  // ДУБЛЬ 2 — совпадение по адресу+площади (пункт 6б), тот же хук/баннер, что
  // на шаге «Где» и на «Проверке» — второй раз не пишем.
  const addressMatches = useDuplicateAddress(full);

  // Имя продавца БЕЗ телефона (пункт 7) — если карточка выбрана в CRM и в
  // черновике своего имени нет (обычный случай после выбора в StepSeller —
  // sellerName/sellerPhone там гасятся), подтягиваем имя карточки.
  const needsSellerName = !full.sellerName.trim() && !!full.sellerClientId;
  const sellerClient = useClient(needsSellerName ? full.sellerClientId : undefined);
  const sellerLabel = full.sellerName.trim() || sellerClient.data?.fullName || (full.sellerClientId ? "Выбран из CRM" : "");
  const rows = [
    ...(sellerLabel ? [{ k: "Продавец", v: sellerLabel, step: stepIndexOf("seller") }] : []),
    ...filledRows(full, districts),
  ];

  // ЧЕГО НЕ ХВАТАЕТ (пункт 1) — validateStep по всем шагам, что реально её
  // проверяют (types.ts, incompleteFieldMessages), плюс фото: validateStep их
  // не требует вовсе, поэтому отдельной строкой.
  const totalPhotos = counts.photos + pendingLocal.photos;
  const missing = [
    ...incompleteFieldMessages(full, { requireIntakeAgent }),
    ...(totalPhotos === 0 ? ["Нет фото"] : []),
  ];

  const continueTarget = firstIncompleteStep(full, { requireIntakeAgent });

  return (
    <div className="rh2">
      <div className="wiz">
        <div className="whead">
          <div className="line1">
            <div style={{ minWidth: 0 }}>
              <div className="ttl" role="heading" aria-level={1}>
                Незаконченный объект
              </div>
              <div className="sub" data-testid="wizard-draft-offer">
                {savedLabel}
              </div>
            </div>
            <button
              type="button"
              className="xbtn"
              onClick={onClose}
              aria-label="Закрыть мастер"
              data-testid="wizard-close"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {daysLeft !== null && (
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <span className={daysLeft <= 2 ? "chip warn" : "chip acc"} data-testid="wizard-draft-expiry">
                {daysLeft <= 0
                  ? "Удалится сегодня"
                  : `Удалится через ${daysLeft} ${pluralDay(daysLeft)}`}
              </span>
            </div>
          )}
        </div>

        <div className="wbody">
          {missing.length > 0 && (
            <section className="blk">
              <div className="chip warn" data-testid="wizard-draft-missing">
                Осталось: {missing.join(", ")}
              </div>
            </section>
          )}

          {media.length > 0 && (
            <section className="blk">
              <div className="head">
                <h4>Фото и видео</h4>
                <span className="sub" style={{ margin: 0 }}>
                  {[counts.photos > 0 ? `${counts.photos} фото` : null, counts.videos > 0 ? `${counts.videos} видео` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="tiles">
                {tiles.map((m, i) => (
                  <div key={m.id} className={i === 0 ? "tile cover" : "tile"}>
                    {m.kind === "PHOTO" && m.thumbUrl ? (
                      <img className="im" src={m.thumbUrl} alt="" loading="lazy" style={{ objectFit: "cover", width: "100%", height: "100%" }} />
                    ) : (
                      <span className="im" style={{ display: "grid", placeItems: "center", color: "var(--muted)" }}>
                        {m.kind === "VIDEO" ? <Film width={18} height={18} aria-hidden /> : <ImageIcon width={18} height={18} aria-hidden />}
                      </span>
                    )}
                    {i === 0 && <span className="badge">Обложка</span>}
                    {i === tiles.length - 1 && hiddenCount > 0 && (
                      <span
                        className="im"
                        style={{
                          display: "grid",
                          placeItems: "center",
                          background: "color-mix(in srgb, var(--ink) 55%, transparent)",
                          color: "var(--card)",
                          fontFamily: "var(--ff-head)",
                          fontWeight: 800,
                          fontSize: 16,
                        }}
                      >
                        +{hiddenCount}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {pendingCount > 0 && (
                <div className="sub" style={{ marginTop: 8 }} data-testid="wizard-draft-pending-uploads">
                  {pendingUploadsLabel(pendingLocal.photos, pendingLocal.videos)} — догрузятся после «Продолжить»
                </div>
              )}
            </section>
          )}
          {media.length === 0 && pendingCount > 0 && (
            <section className="blk">
              <div className="sub" data-testid="wizard-draft-pending-uploads">
                {pendingUploadsLabel(pendingLocal.photos, pendingLocal.videos)} — догрузятся после «Продолжить»
              </div>
            </section>
          )}

          {rows.length > 0 && (
            <section className="blk">
              <div className="rev">
                {rows.map((r) => (
                  <button
                    key={r.k}
                    type="button"
                    className="r"
                    style={{ width: "100%", background: "none", border: 0, cursor: "pointer" }}
                    onClick={() => onGoTo(r.step)}
                    data-testid={`wizard-draft-row-${r.k}`}
                  >
                    <span className="k">{r.k}</span>
                    <span className="v">{r.v}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {sellerProperties.length > 0 && (
            <section className="blk">
              <div className="dup" data-testid="wizard-draft-seller-duplicate">
                <span className="dot" aria-hidden />
                <span>
                  У продавца уже есть{" "}
                  <Link
                    to={`/properties/${sellerProperties[0].shortId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "inherit", textDecoration: "underline" }}
                  >
                    ОБ-{String(sellerProperties[0].shortId).padStart(6, "0")}
                  </Link>
                  {sellerProperties.length > 1 ? ` и ещё ${sellerProperties.length - 1}` : ""}
                </span>
              </div>
            </section>
          )}

          <DuplicateAddressWarning matches={addressMatches} />
        </div>

        {restartError && (
          <div className="blk">
            <div className="quiet crit" role="alert" data-testid="wizard-draft-restart-error">
              <span className="dot crit" aria-hidden />
              <span className="txt">{restartError}</span>
            </div>
          </div>
        )}
        <div className="wfoot">
          <button
            type="button"
            className="back"
            data-testid="wizard-draft-restart"
            disabled={restartPending}
            onClick={() => setConfirmOpen(true)}
          >
            {restartPending ? "Удаляю…" : "Начать заново"}
          </button>
          <button
            type="button"
            className="next"
            data-testid="wizard-draft-continue"
            disabled={restartPending}
            onClick={() => onGoTo(continueTarget)}
          >
            Продолжить
          </button>
        </div>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Начать объект заново?"
          description="Черновик и уже отданные фото/видео удалятся безвозвратно — восстановить их будет нельзя."
          confirmLabel="Начать заново"
          onConfirm={() => {
            setConfirmOpen(false);
            onRestart();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function pluralDay(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

function pendingUploadsLabel(photos: number, videos: number): string {
  const bits: string[] = [];
  if (photos > 0) bits.push(`${photos} фото`);
  if (videos > 0) bits.push(`${videos} видео`);
  return `${bits.join(", ")} ещё не ${photos + videos === 1 ? "ушло" : "ушли"}`;
}

/** Только заполненное — строками шага «Проверка», каждая ведёт на свой шаг
 *  (пункт 3 задания). Порядок и состав — как на «Проверке», кроме «Состояния»
 *  (пункт 9: значение по умолчанию не несёт информации на этом экране) и
 *  телефона продавца (пункт 7: только имя). */
function filledRows(v: WizardValues, districts: District[]): { k: string; v: string; step: number }[] {
  const rows: { k: string; v: string; step: number }[] = [];
  const mainStep = stepIndexOf("main");
  const placeStep = stepIndexOf("place");

  // Продавец — своя строка, собирается в компоненте (нужен результат useClient
  // для карточки из CRM, сюда его синхронно не протащить) — см. вызов filledRows.

  // Вид и состояние в пустой форме стоят по умолчанию — это не «заполнено
  // агентом», показываем только когда агент реально его сменил.
  if (v.type && v.type !== EMPTY_WIZARD_VALUES.type && v.type in PROPERTY_TYPE_LABELS) {
    rows.push({ k: "Вид", v: PROPERTY_TYPE_LABELS[v.type as PropertyType], step: mainStep });
  }
  if (needsRooms(v.type) && v.rooms.trim()) rows.push({ k: "Комнат", v: v.rooms.trim(), step: mainStep });
  if (v.areaSqm.trim()) rows.push({ k: "Площадь", v: `${v.areaSqm.trim()} м²`, step: mainStep });
  if (needsLandArea(v.type) && v.landAreaSotka.trim()) {
    rows.push({ k: "Сотки", v: `${v.landAreaSotka.trim()} сот.`, step: mainStep });
  }
  if (propertyFieldShown(v.type, "floor") && v.floor.trim()) {
    rows.push({ k: "Этаж", v: v.totalFloors.trim() ? `${v.floor.trim()} из ${v.totalFloors.trim()}` : v.floor.trim(), step: mainStep });
  }
  if (v.price.trim() && !Number.isNaN(Number(v.price))) {
    const money = Number(v.price).toLocaleString("ru-RU");
    rows.push({ k: "Цена", v: `${money} ${v.currency === "USD" ? "$" : "сомони"}`, step: mainStep });
  }
  const district = v.districtId ? districts.find((d) => d.id === v.districtId)?.name : undefined;
  if (district) rows.push({ k: "Район", v: district, step: placeStep });
  if (v.address.trim()) rows.push({ k: "Адрес", v: v.address.trim(), step: placeStep });
  return rows;
}

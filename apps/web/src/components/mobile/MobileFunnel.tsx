import { useState } from "react";
import { Link } from "react-router-dom";
import { LEAD_MAGNET_STATE_LABELS, type LeadMagnetState } from "@royal-home/shared";
import { Switch } from "../Switch";
import { ConfirmDialog } from "../ConfirmDialog";
import { DismissibleHint } from "../ui/DismissibleHint";
import { Pagination } from "../Pagination";
import { useCan } from "../../lib/permissions";
import { relativeTime } from "../../lib/format";
import { journalTotals, resolveEditingCampaign } from "../../lib/leadMagnetView";
import {
  useDeleteLeadMagnet,
  useDuplicateLeadMagnet,
  useLeadMagnetDeliveries,
  useLeadMagnets,
  useToggleLeadMagnetEnabled,
  type LeadMagnetCampaignRow,
} from "../../hooks/useLeadMagnets";
import { FunnelEditor } from "../../pages/settings/FunnelEditor";
import { FunnelRehearsal } from "../../pages/settings/FunnelRehearsal";
import { campaignTerms, deliveryChip, followLabel } from "../../pages/settings/FunnelTab";

/**
 * Мобильная «Воронка» — тот же эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/funnel.html), что и на десктопе: `.pg-h`,
 * тихая строка `.quiet.warn`, карточки `.mag-card` (на ширине ≤820 сетка `.mag`
 * сама становится одноколоночной), лента срезов `.seg` в `.hscroll`.
 *
 * ЕДИНСТВЕННОЕ ОТЛИЧИЕ ОТ ДЕСКТОПА. Журнал выдач в макете — таблица `.tbl` с
 * колонками `.only-wide`; на телефоне от неё остаются три колонки и
 * горизонтальная прокрутка. Здесь та же строка данных собрана в `.row` эталона,
 * где всё помещается по вертикали. Данные, срезы, права и пагинация те же.
 *
 * Редактор кампании (FunnelEditor) и репетиция (FunnelRehearsal) не копируются:
 * оба уже одноколоночные и во всю ширину на маленьком экране. Заводить вторую
 * версию тех же полей значило бы держать в двух местах текст, который уходит
 * клиенту от имени компании, и один из них рано или поздно отстанет.
 *
 * Права — как на сервере (routes/leadMagnets.ts): смотреть — settings.view,
 * менять — settings.manage. Экран не проверяет settings.view сам — за этим
 * следит Funnel.tsx до ветвления на мобильную/десктопную версию.
 */
export function MobileFunnel() {
  const can = useCan();
  const canManage = can("settings.manage");
  const { data: campaigns, isLoading, error } = useLeadMagnets();
  const [editing, setEditing] = useState<{ campaign: LeadMagnetCampaignRow | null } | null>(null);
  const [rehearsing, setRehearsing] = useState<LeadMagnetCampaignRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LeadMagnetCampaignRow | null>(null);
  const [journalOf, setJournalOf] = useState<string | "all" | null>(null);
  const remove = useDeleteLeadMagnet();
  const duplicate = useDuplicateLeadMagnet();

  if (editing) {
    // Обёртка темы и рамка экрана — здесь: редактор возвращается ВМЕСТО этого
    // экрана, и без `.rh2` его разметка макета осталась бы без единого стиля.
    return (
      <div className="rh2 screens">
        <div className="scr">
          <FunnelEditor campaign={resolveEditingCampaign(editing, campaigns)} onClose={() => setEditing(null)} />
        </div>
      </div>
    );
  }

  const failedTotal = (campaigns ?? []).reduce((sum, c) => sum + c.stats.failed, 0);
  const enabledCount = (campaigns ?? []).filter((c) => c.enabled).length;
  const disabledCount = (campaigns?.length ?? 0) - enabledCount;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Воронка</h1>
            <p className="sub">
              Человек пишет ключевое слово под рекламным роликом, CRM отвечает ему публично и присылает чек-лист в
              личные сообщения. Кто дошёл до файла и кто оставил телефон, видно ниже.
            </p>
          </div>
          {canManage && (
            <div className="acts">
              <button className="pill ghost" type="button" onClick={() => setEditing({ campaign: null })}>
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Новая кампания
              </button>
            </div>
          )}
        </div>

        <div className="card tight">
          <DismissibleHint id="funnel-intro-mobile">
            Instagram разрешает по комментарию отправить <b>одно</b> сообщение, поэтому первым уходит не файл, а
            кнопка. Если бот в Instagram выключен, новых людей воронка не ловит; тем, кого уже пригласили, файл
            уходит в любом случае.
          </DismissibleHint>
        </div>

        {failedTotal > 0 && (
          <div className="card tight">
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Не дошло файлов: {failedTotal}. Причина у каждого записана в журнале выдач.</span>
              <button className="lnk" type="button" onClick={() => setJournalOf("all")}>
                Открыть журнал
              </button>
            </div>
          </div>
        )}

        {(remove.isError || duplicate.isError) && (
          <div className="card tight">
            {remove.isError && (
              <div className="quiet crit" role="alert">
                <span className="dot crit" />
                <span className="txt">{remove.error instanceof Error ? remove.error.message : "Не удалось удалить кампанию"}</span>
                <button className="lnk" type="button" onClick={() => remove.reset()}>
                  Понятно
                </button>
              </div>
            )}
            {duplicate.isError && (
              <div className="quiet crit" role="alert">
                <span className="dot crit" />
                <span className="txt">
                  {duplicate.error instanceof Error ? duplicate.error.message : "Не удалось создать копию кампании"}
                </span>
                <button className="lnk" type="button" onClick={() => duplicate.reset()}>
                  Понятно
                </button>
              </div>
            )}
          </div>
        )}

        <div className="sec-h">
          <h2>Кампании</h2>
          <span className="note">
            {enabledCount} работают, {disabledCount} выключены
          </span>
        </div>

        {isLoading ? (
          <div className="card tight">
            <div className="state">
              <span className="sk w40" />
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем кампании
            </div>
          </div>
        ) : error ? (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" />
              {error instanceof Error ? error.message : "Не удалось загрузить кампании."}
            </div>
          </div>
        ) : (campaigns?.length ?? 0) === 0 ? (
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
                </svg>
              </span>
              <p>
                Кампаний пока нет. Заведите кампанию под рекламный ролик: ключевое слово, тексты и файл. Дальше CRM
                всё сделает сама.
              </p>
              {canManage && (
                <button className="pill ghost" type="button" onClick={() => setEditing({ campaign: null })}>
                  Новая кампания
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mag">
            {campaigns!.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                canManage={canManage}
                onEdit={() => setEditing({ campaign: c })}
                onRehearse={() => setRehearsing(c)}
                onDelete={() => setConfirmDelete(c)}
                onJournal={() => setJournalOf(c.id)}
                duplicating={duplicate.isPending}
                onDuplicate={() => duplicate.mutate(c.id, { onSuccess: (copy) => setEditing({ campaign: copy }) })}
              />
            ))}
          </div>
        )}

        {/* key по кампании: журнал другой кампании — другая выдача, и её
            страница и срез начинаются заново, а не с номера страницы прежней. */}
        <Journal
          key={journalOf ?? "closed"}
          campaignId={journalOf}
          onChange={setJournalOf}
          /* Счётчики на срезах — по уже загруженным кампаниям, в журнале одной
             кампании только её (WEB-PAGES15), как на ПК
             (pages/settings/FunnelTab.tsx): invited — это «всего», а не «сейчас
             на этом шаге», поэтому «Все» и «Написали в директ» совпадают. */
          totals={campaigns ? journalTotals(campaigns, journalOf) : undefined}
        />

        {rehearsing && <FunnelRehearsal campaign={rehearsing} onClose={() => setRehearsing(null)} />}

        {confirmDelete && (
          <ConfirmDialog
            title="Удалить кампанию?"
            description={`«${confirmDelete.name}» исчезнет вместе с журналом выдач: кто получил файл, будет уже не посмотреть. Люди, которым файл уже ушёл, останутся в переписке.`}
            confirmLabel="Удалить"
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              remove.mutate(confirmDelete.id);
              setConfirmDelete(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Одна кампания — карточка `.mag-card` эталона, та же, что на десктопе. */
function CampaignCard({
  campaign,
  canManage,
  onEdit,
  onRehearse,
  onDelete,
  onJournal,
  onDuplicate,
  duplicating,
}: {
  campaign: LeadMagnetCampaignRow;
  canManage: boolean;
  onEdit: () => void;
  onRehearse: () => void;
  onDelete: () => void;
  onJournal: () => void;
  onDuplicate: () => void;
  duplicating: boolean;
}) {
  // НЕ silent, в отличие от remove/duplicate выше (аудит 22.08.2026, раунд 5):
  // этот экземпляр обслуживает только тумблер кампании, и общий тост — его
  // единственное подтверждение успеха.
  const update = useToggleLeadMagnetEnabled();

  function toggle() {
    // Только флаг, а не снимок кампании: устаревший снимок откатил бы чужие правки (WEB-PAGES13).
    update.mutate({ id: campaign.id, enabled: !campaign.enabled });
  }

  const s = campaign.stats;
  const mid = Math.max(0, s.delivered - s.leads);
  const rest = Math.max(0, s.invited - s.delivered);
  const gotLabel = campaign.fileName ? "получили файл" : campaign.link ? "получили ссылку" : "получили текст";

  return (
    <article className="mag-card">
      <div className="wrap">
        <h3 style={{ flex: 1 }}>{campaign.name}</h3>
        <span className={campaign.enabled ? "chip ok" : "chip mute"}>
          <span className={campaign.enabled ? "dot ok" : "dot"} />
          {campaign.enabled ? "Ловит комментарии" : "Выключена"}
        </span>
        <Switch on={campaign.enabled} disabled={!canManage} onToggle={toggle} label={`Кампания «${campaign.name}»`} />
      </div>

      <p style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>{campaignTerms(campaign)}</p>

      {campaign.postUrl && (
        <p style={{ fontSize: "var(--fs-13)" }}>
          <a className="lk" href={campaign.postUrl} target="_blank" rel="noreferrer">
            Публикация в Instagram
          </a>
        </p>
      )}

      {update.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{update.error instanceof Error ? update.error.message : "Не удалось изменить кампанию"}</span>
          <button className="lnk" type="button" onClick={() => update.reset()}>
            Понятно
          </button>
        </div>
      )}

      <div className="nums">
        <div>
          <b>{s.invited}</b>
          <small>написали в директ</small>
        </div>
        <div>
          <b>{s.awaitingFollow}</b>
          <small>ждут подписки</small>
        </div>
        <div>
          <b>{s.delivered}</b>
          <small>{gotLabel}</small>
        </div>
        <div>
          <b>{s.leads}</b>
          <small>стали клиентами</small>
        </div>
      </div>

      {s.invited > 0 && (
        <div className="prog split" aria-hidden="true" style={{ marginTop: "4px" }}>
          <i className="ok" style={{ "--v": s.leads } as React.CSSProperties} />
          <i style={{ "--v": mid } as React.CSSProperties} />
          <i className="rest" style={{ "--v": rest } as React.CSSProperties} />
        </div>
      )}

      {s.failed > 0 && (
        <p style={{ fontSize: "var(--fs-13)", color: "var(--crit)" }}>Не дошло: {s.failed}. В журнале записана причина.</p>
      )}

      <div className="wrap">
        {canManage && (
          <button className="pill ghost sm" type="button" onClick={onEdit}>
            Изменить
          </button>
        )}
        {canManage && (
          <button className="pill ghost sm" type="button" onClick={onDuplicate} disabled={duplicating}>
            {duplicating ? "Копирую…" : "Дублировать"}
          </button>
        )}
        <button className="pill ghost sm" type="button" onClick={onRehearse}>
          Репетиция
        </button>
        <button className="lnk" type="button" onClick={onJournal}>
          Журнал выдач
        </button>
        {canManage && (
          <button className="lnk" type="button" onClick={onDelete}>
            Удалить
          </button>
        )}
      </div>
    </article>
  );
}

const STATES: (LeadMagnetState | "all")[] = ["all", "INVITED", "AWAITING_FOLLOW", "DELIVERED", "FAILED"];

/** Журнал выдач: на телефоне та же строка данных, что в таблице, но в `.row`. */
function Journal({
  campaignId,
  onChange,
  totals,
}: {
  campaignId: string | "all" | null;
  onChange: (v: string | "all" | null) => void;
  /** Счётчики для бейджей `.n` на срезах — undefined, пока кампании не загрузились. */
  totals?: { invited: number; awaitingFollow: number; delivered: number; failed: number };
}) {
  const [state, setState] = useState<LeadMagnetState | "all">("all");
  const [page, setPage] = useState(1);
  const open = campaignId !== null;
  const { data, isLoading, error } = useLeadMagnetDeliveries(
    {
      campaignId: campaignId && campaignId !== "all" ? campaignId : undefined,
      state: state === "all" ? undefined : state,
      page,
    },
    open
  );

  if (!open) {
    return (
      <div className="wrap">
        <button className="pill ghost" type="button" onClick={() => onChange("all")}>
          Показать журнал выдач
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="sec-h">
        <h2>Журнал выдач</h2>
        <span className="note">кто пришёл по рекламе и чем кончилось</span>
      </div>
      <div className="card">
        <div className="wrap" style={{ marginBottom: "var(--s3)" }}>
          <div className="hscroll" style={{ flex: 1 }}>
            <div className="seg" role="tablist" aria-label="Срезы журнала">
              {STATES.map((s) => {
                const count = totals
                  ? s === "all"
                    ? totals.invited
                    : s === "INVITED"
                      ? totals.invited
                      : s === "AWAITING_FOLLOW"
                        ? totals.awaitingFollow
                        : s === "DELIVERED"
                          ? totals.delivered
                          : totals.failed
                  : undefined;
                return (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={state === s}
                    onClick={() => {
                      setState(s);
                      setPage(1);
                    }}
                  >
                    {s === "all" ? "Все" : LEAD_MAGNET_STATE_LABELS[s]}
                    {count !== undefined && <span className="n">{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <button className="lnk" type="button" onClick={() => onChange(null)}>
            Скрыть
          </button>
        </div>

        {isLoading ? (
          <div className="state">
            <span className="sk w28" />
            <span className="sk w22" /> Загружаем журнал
          </div>
        ) : error ? (
          <div className="state err">
            <span className="dot crit" />
            {error instanceof Error ? error.message : "Не удалось загрузить журнал."}
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <p className="state">Под этот срез пока никто не подошёл.</p>
        ) : (
          <div className="list">
            {data!.items.map((d) => (
              <div className="row" key={d.id}>
                <div className="t">
                  <b>
                    {d.clientShortId ? (
                      <Link className="lk" to={`/clients/${d.clientShortId}`}>
                        {d.username ? `@${d.username}` : "Подписчик"}
                      </Link>
                    ) : (
                      (d.username ? `@${d.username}` : "Подписчик")
                    )}
                  </b>
                  <span>
                    {d.commentText ? `«${d.commentText}». ` : ""}
                    {d.campaignName}. Подписка: {followLabel(d)}
                    {d.state === "DELIVERED" && d.deliveredAsFile ? ". Файлом" : ""}
                    {d.lastError ? `. ${d.lastError}` : ""}
                  </span>
                </div>
                <span className={deliveryChip(d.state)}>{LEAD_MAGNET_STATE_LABELS[d.state]}</span>
                <span className="meta">{relativeTime(d.invitedAt)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Пагинация — общий компонент списков CRM (см. components/Pagination.tsx). */}
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />}
      </div>
    </>
  );
}

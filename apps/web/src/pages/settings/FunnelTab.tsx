import { useState } from "react";
import { Link } from "react-router-dom";
import { LEAD_MAGNET_STATE_LABELS, type LeadMagnetState } from "@royal-home/shared";
import { Switch } from "../../components/Switch";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DismissibleHint } from "../../components/ui/DismissibleHint";
import { Pagination } from "../../components/Pagination";
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
import { FunnelEditor } from "./FunnelEditor";
import { FunnelRehearsal } from "./FunnelRehearsal";
import { scrollableRegion } from "../../lib/a11y";

/**
 * Экран «Воронка» — кампании «комментарий под рекламой → чек-лист в директ».
 *
 * Разметка перенесена дословно из эталона темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/funnel.html): `.pg-h`, тихая строка `.quiet.warn`
 * о недошедших файлах, сетка карточек `.mag`/`.mag-card` со счётчиками `.nums` и
 * полосой `.prog.split`, журнал выдач лентой срезов `.seg` и таблицей `.tbl`,
 * блок состояний `.empty`/`.state`.
 *
 * Под рекламный ролик заводится кампания: ключевое слово, тексты, PDF. Дальше всё
 * делает автомат (apps/api/src/lib/leadMagnet.ts) — без единого обращения к ИИ,
 * потому что решать там нечего, а реклама приводит сотни человек за вечер.
 *
 * Права те же, что на сервере (routes/leadMagnets.ts): смотреть — settings.view,
 * менять — settings.manage. Порядок карточек — как отдаёт сервер.
 */
export function FunnelTab() {
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
          <DismissibleHint id="funnel-intro">
            Instagram разрешает по комментарию отправить <b>одно</b> сообщение, поэтому первым уходит не файл, а
            кнопка: нажатие открывает переписку, и уже после него проверяется подписка и уходит PDF. ИИ здесь не
            участвует, токены не тратятся. Если бот в Instagram выключен (вкладка «Бот»), новых людей воронка не
            ловит: она отвечает публично под постом, а выключенный бот молчит везде. Тем, кого уже пригласили, файл
            уходит в любом случае, даже если кампанию потом выключить.
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
                /* Сразу открываем копию в редакторе: у неё та же публикация и те же
                   ключевые слова, что у оригинала, и оставить её в списке как есть —
                   значит завести вторую кампанию-двойника. */
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
          /* Счётчики на срезах — по уже загруженным кампаниям, а в журнале одной
             кампании только её (WEB-PAGES15; тот же
             `stats`, что в плитках `.nums`), а не отдельный запрос: invited —
             это «всего», а не «сейчас на этом шаге» (packages/shared/leadMagnet.ts),
             поэтому «Все» и «Написали в директ» совпадают, как в эталоне. */
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

/** Что кампания отдаёт и кому — строка условий под названием (эталон, .mag-card p). */
export function campaignTerms(campaign: LeadMagnetCampaignRow): string {
  const parts: string[] = [];
  if (campaign.anyComment) parts.push("На любой комментарий");
  else parts.push(`Слова: ${campaign.keywords.join(", ") || "не заданы"}`);
  if (campaign.fileName) parts.push(`Отдаём файлом «${campaign.fileName}»`);
  else if (campaign.link) parts.push("Отдаём ссылкой");
  else parts.push("Отдаём текстом");
  parts.push(campaign.requireFollow ? "Только подписчикам" : "Без подписки");
  if (!campaign.postUrl && !campaign.postUrls?.length) parts.push("Под всеми публикациями");
  else if (campaign.postUrls?.length) parts.push(`Публикаций: ${campaign.postUrls.length + (campaign.postUrl ? 1 : 0)}`);
  return `${parts.join(". ")}.`;
}

/** Одна кампания: состояние, счётчики воронки и действия. */
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
  /** Копия делается на сервере (вместе с файлом) — на медленной связи это заметно,
   *  и кнопка обязана показать, что нажатие услышано, иначе по ней жмут второй раз
   *  и получают две копии. */
  duplicating: boolean;
}) {
  // НЕ silent: общий тост — единственное подтверждение успеха у тумблера.
  const update = useToggleLeadMagnetEnabled();

  // Выдача бывает трёх видов, и «только текстом» — законный: обещанное могло быть
  // промокодом, адресом или ответом на вопрос. Поэтому отсутствие файла включению
  // не мешает; в строке под названием видно, что именно получит человек.
  function toggle() {
    // PATCH принимает кампанию целиком: посылаем то же самое, меняя один флаг.
    // Только флаг, а не снимок кампании: устаревший снимок откатил бы чужие правки (WEB-PAGES13).
    update.mutate({ id: campaign.id, enabled: !campaign.enabled });
  }

  const s = campaign.stats;
  // Полоса эталона: слева стали клиентами, в середине получившие файл, справа
  // остаток тех, кто написал, но файла ещё не получил.
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
        {/* Тумблер — общий компонент Настроек: у него своя доступность
            (role=switch) и оптимистичное поведение, ради облика их не переписываем. */}
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

      {/* Воронка слева направо: пришли, застряли на подписке, получили,
          оставили телефон. Последнее число и есть польза кампании. */}
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
          <button
            className="pill ghost sm"
            type="button"
            onClick={onDuplicate}
            disabled={duplicating}
            title="Копия со всеми текстами и файлом, останется поменять публикацию и ключевое слово"
          >
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

/** Тон чипа состояния выдачи — три состояния эталона: ok, warn, crit. */
export function deliveryChip(state: LeadMagnetState): string {
  if (state === "DELIVERED") return "chip ok";
  if (state === "FAILED") return "chip crit";
  if (state === "AWAITING_FOLLOW") return "chip warn";
  return "chip mute";
}

/** Подписка человека одной строкой — колонка «Подписка» эталона. */
export function followLabel(d: { wasFollowing: boolean | null; followChecks: number }): string {
  if (d.wasFollowing === true) return "есть";
  if (d.wasFollowing === false) return "нет";
  if (d.followChecks > 0) return `спросили ${d.followChecks} раз`;
  return "не проверяли";
}

/** Журнал выдач: кто пришёл по рекламе и чем кончилось. */
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
          <div className="tbl-wrap" {...scrollableRegion("Журнал воронки")}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Человек</th>
                  <th className="only-wide">Кампания</th>
                  <th>Что было</th>
                  <th className="only-wide">Подписка</th>
                  <th className="num">Когда</th>
                </tr>
              </thead>
              <tbody>
                {data!.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.clientShortId ? (
                        <Link className="lk" to={`/clients/${d.clientShortId}`}>
                          {d.username ? `@${d.username}` : "Подписчик"}
                        </Link>
                      ) : (
                        <span style={{ fontWeight: 600, color: "var(--ink)" }}>{d.username ? `@${d.username}` : "Подписчик"}</span>
                      )}
                      {d.commentText && (
                        <span style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--faint)" }}>«{d.commentText}»</span>
                      )}
                    </td>
                    <td className="only-wide">{d.campaignName}</td>
                    <td>
                      <span className={deliveryChip(d.state)}>{LEAD_MAGNET_STATE_LABELS[d.state]}</span>
                      {/* «Файлом» пишем только когда файл правда ушёл: раньше во всех
                          остальных случаях стояло «ссылкой», и это была неправда для
                          кампаний, которые выдают текстом, и для сорвавшихся файлов. */}
                      {d.state === "DELIVERED" && d.deliveredAsFile && (
                        <span style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--muted)", marginTop: "4px" }}>файлом</span>
                      )}
                      {d.lastError && (
                        <span style={{ display: "block", fontSize: "var(--fs-12)", color: "var(--muted)", marginTop: "4px" }}>{d.lastError}</span>
                      )}
                    </td>
                    <td className="only-wide">{followLabel(d)}</td>
                    <td className="num">{relativeTime(d.invitedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Пагинация — общий компонент списков CRM: он же чинит «страницу за краем
            выдачи» (см. components/Pagination.tsx), и своя копия этой правки в
            экране разошлась бы с остальными пятнадцатью списками. */}
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />}
      </div>
    </>
  );
}

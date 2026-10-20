import { ArrowUpRight, Globe, Handshake, Megaphone, Footprints, ClipboardCheck, Image, Clapperboard, Phone, Users, UserRound, Radio, MessageSquare, RotateCcw, Trash2, BarChart3 } from "lucide-react";
import { channelMeta } from "../../lib/channelMeta";
import { CleanPropertyIllustration } from "./CleanPropertyIllustration";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { mcOk, type MissionControlData, type McDialogZone } from "../../hooks/useMissionControl";
import { inboxOpenHref } from "../../lib/inboxLink";
import { formatMoneyExact } from "../../lib/format";
import { CCard, CHead, CChip, CLink, CAvatar } from "./ui";

type AllowedRoute = (path: string) => boolean;
interface QueueRow { id: string; title: string; detail?: string; href?: string; channel?: string; avatar?: string | null; person?: boolean; property?: boolean; context?: string; metrics?: { label: string; value: number | string }[]; connected?: boolean }
interface Queue { id: string; title: string; total: number; rows: QueueRow[]; detail?: ReactNode; metrics?: { label: string; value: number | string }[] }

/** Check internal paths before retaining any server-supplied deep link. */
export function allowedQueueHref(href: string | undefined, allowed: AllowedRoute): string | undefined {
  if (!href || !href.startsWith("/") || /^\/\//.test(href) || /[\\\s\u0000-\u001f]/.test(href)) return undefined;
  const path = href.split(/[?#]/)[0];
  if (path.split("/").some((part) => part === "." || part === ".." || /%2e|%2f|%5c/i.test(part))) return undefined;
  const section = `/${path.split("/")[1]}`;
  return allowed(path) || allowed(section) ? href : undefined;
}

export function buildCleanWorkQueues(data: MissionControlData, allowed: AllowedRoute): Queue[] {
  const queues: Queue[] = [];
  const href = (value: string) => allowedQueueHref(value, allowed);
  const add = (queue: Queue, meaningful = false) => { if (meaningful || queue.total > 0 || queue.rows.length > 0) queues.push(queue); };
  if (!data.modulesOff.includes("bot") && mcOk(data.bot) && data.bot.attention && allowed("/messages")) {
    const dialogs = (id: string, title: string, zone: McDialogZone) => add({ id, title, total: zone.count,
      rows: zone.items.map((item) => ({ id: item.id, title: item.title, channel: item.channel, context: `Ждёт ${item.waitingMinutes} мин`, detail: `${item.channel} · ждёт ${item.waitingMinutes} мин`, href: href(inboxOpenHref(item.kind, item.id)) })) });
    dialogs("waiting", "Ждут человека", data.bot.attention.waitingHuman);
    dialogs("silent", "Диалоги без ответа", data.bot.attention.silent);
  }
  if (!data.modulesOff.includes("calls") && mcOk(data.calls) && allowed("/calls")) {
    const calls = data.calls;
    add({ id: "calls", title: "Звонки", total: calls.live.incoming.length + calls.live.outgoing.length,
      detail: `Сегодня: входящих ${calls.today.incoming}, исходящих ${calls.today.outgoing}, пропущенных ${calls.today.missed}, неквалифицированных ${calls.today.unqualified}`,
      rows: [...calls.live.incoming.map((item) => ({ id: `in-${item.channelId}`, title: item.clientName ?? "Входящий звонок", detail: `${item.answered ? "Отвечен" : "Ожидает ответа"} · ${item.seconds} с`, href: item.clientShortId !== null ? href(`/clients/${item.clientShortId}`) : href("/calls") })),
        ...calls.live.outgoing.map((item) => ({ id: `out-${item.channelId}`, title: item.clientName ?? "Исходящий звонок", detail: item.state, href: item.clientShortId !== null ? href(`/clients/${item.clientShortId}`) : href("/calls") }))] });
    // A completed day still has meaningful call totals even with no live channel.
    if (queues.every((q) => q.id !== "calls") && Object.values(calls.today).some((n) => n > 0))
      queues.push({ id: "calls", title: "Звонки за сегодня", total: 0, rows: [], detail: `Входящих ${calls.today.incoming}, исходящих ${calls.today.outgoing}, пропущенных ${calls.today.missed}, неквалифицированных ${calls.today.unqualified}` });
  }
  if (!data.modulesOff.includes("marketing") && mcOk(data.marketing)) {
    const marketing = data.marketing;
    if (allowed("/sources")) {
      const channels = marketing.funnel.filter((channel) => channel.leadsMonth > 0 || channel.showingsMonth > 0 || channel.dealsClosedMonth > 0 || channel.leadsToday > 0 || channel.anomalyLeadsDown || (data.seesMoney && ((channel.spendMonthTjs ?? 0) > 0 || (channel.commissionMonthTjs ?? 0) > 0)));
      add({ id: "funnel", title: "Результаты каналов", total: channels.length, detail: `Месяц ${marketing.funnelMonth}`,
        rows: channels.map((channel) => ({ id: channel.source, title: channel.label, channel: channel.source, metrics: [{ label: "Обращения", value: channel.leadsMonth }, { label: "Показы", value: channel.showingsMonth }, { label: "Сделки", value: channel.dealsClosedMonth }], context: channel.anomalyLeadsDown ? "Обращений меньше среднего" : `Сегодня: ${channel.leadsToday}`, href: href("/sources"),
          detail: [
            `Обращений ${channel.leadsMonth} · показов ${channel.showingsMonth} · закрыто сделок ${channel.dealsClosedMonth}`,
            `Сегодня ${channel.leadsToday} · среднее за 7 дней ${channel.leadsTrailing7Avg}`,
            channel.anomalyLeadsDown ? "Обращений заметно меньше среднего" : undefined,
            data.seesMoney && channel.spendMonthTjs !== null ? `Расход ${formatMoneyExact(channel.spendMonthTjs, "TJS")}` : undefined,
            data.seesMoney && channel.commissionMonthTjs !== null ? `Комиссия ${formatMoneyExact(channel.commissionMonthTjs, "TJS")}` : undefined,
            data.seesMoney && channel.costPerLeadTjs !== null ? `Цена обращения ${formatMoneyExact(channel.costPerLeadTjs, "TJS")}` : undefined,
          ].filter(Boolean).join(" · "),
        })) });
    }
    const queue = data.marketing.publishQueue;
    if (queue && allowed("/marketing")) add({ id: "publish", title: "Очередь публикации", total: queue.count,
      detail: `Опубликовано: ${queue.publishedCount}`,
      rows: queue.items.map((item) => ({ id: item.id, title: item.title, property: true, context: `Ожидает публикации ${item.waitingDays} дн.`, detail: `Ожидает ${item.waitingDays} дн.`, href: href(`/properties/${item.shortId}`) })) });
    const channels = data.marketing.channels;
    if (channels && allowed("/settings")) add({ id: "channels", title: "Каналы", total: channels.items.length,
      detail: `Подключено ${channels.connectedCount} · открытых ошибок ${channels.openErrors} · автопубликация ${channels.autoPublishEnabled ? "включена" : "выключена"}`,
      rows: channels.items.map((item) => ({ id: item.id, title: item.label, channel: item.id.toUpperCase(), connected: item.connected, context: item.botEnabled === null ? undefined : item.botEnabled ? "Бот включён" : "Бот выключен", detail: `${item.connected ? "Подключён" : "Не подключён"}${item.botEnabled === null ? "" : item.botEnabled ? " · бот включён" : " · бот выключен"} · ${item.detail}`, href: href("/settings?tab=channels") })) }, channels.openErrors > 0);
  }
  if (!data.modulesOff.includes("video") && mcOk(data.video) && allowed("/pipeline")) {
    const p = data.video.pipeline;
    add({ id: "video", title: "Подготовка объектов", total: p.total, rows: [], metrics: [{label: "Проверка", value:p.awaitingReview}, {label:"Фото",value:p.awaitingPhotos}, {label:"Видео",value:p.awaitingVideo}, {label:"Монтаж",value:p.editing}, {label:"Просрочено",value:p.overdue}],
      detail: `Проверка ${p.awaitingReview} · фото ${p.awaitingPhotos} · видео ${p.awaitingVideo} · монтаж ${p.editing} · просрочено ${p.overdue}` });
  }
  if (mcOk(data.clientsZone)) {
    const { attentionClient: attention, returned, deleteRequests } = data.clientsZone;
    if (attention.id && allowed("/clients")) add({ id: "attention", title: "Клиент требует внимания", total: 1,
      rows: [{ id: attention.id, title: attention.fullName ?? "Клиент", person: true, context: attention.why, metrics: attention.hoursSinceContact !== undefined ? [{label:"Часов без контакта",value:attention.hoursSinceContact}] : undefined, detail: [attention.why, attention.agentName, attention.hoursSinceContact !== undefined ? `${attention.hoursSinceContact} ч без контакта` : undefined].filter(Boolean).join(" · "), href: attention.shortId !== undefined ? href(`/clients/${attention.shortId}`) : href("/clients") }] });
    if (allowed("/clients")) add({ id: "returned", title: "Вернувшиеся клиенты", total: returned.count,
      rows: returned.items.map((item) => ({ id: item.id, title: item.fullName, detail: item.agentName ?? "Без агента", href: href(`/clients/${item.shortId}`) })) });
    if (allowed("/archive")) add({ id: "delete", title: "Заявки на удаление", total: deleteRequests.total,
      rows: deleteRequests.items.filter((item) => !!href(item.href)).map((item) => ({ id: item.id, title: item.title, detail: [item.reason, item.requestedBy].filter(Boolean).join(" · "), href: href(item.href) })) });
  }
  if (!data.modulesOff.includes("team") && mcOk(data.team) && allowed("/team")) add({ id: "team", title: "Нагрузка команды", total: data.team.agents.length,
    rows: data.team.agents.map((agent) => ({ id: agent.id, title: agent.fullName, person: true, avatar: agent.avatarUrl, metrics: [{label:"В работе",value:agent.activeLoad},{label:"Ждут принятия",value:agent.pendingAccept},{label:"Принято сегодня",value:agent.acceptedToday}], context: agent.takesLeads === undefined ? undefined : agent.takesLeads ? "Принимает лиды" : "Приём лидов на паузе", detail: `В работе ${agent.activeLoad} · ждут принятия ${agent.pendingAccept} · принято сегодня ${agent.acceptedToday} · покупателей ${agent.buyerCount} · продавцов ${agent.sellerCount}${agent.takesLeads === undefined ? "" : agent.takesLeads ? " · принимает лиды" : " · приём лидов на паузе"}`, href: href(`/team/${agent.id}`) })) });
  return queues;
}

/** Read-only drill-downs over the same mission-control snapshot. No extra requests. */
export function CleanWorkQueues({ data, allowedRoute, propertyPhotos }: { data: MissionControlData; allowedRoute: AllowedRoute; propertyPhotos?: ReadonlyMap<string, string> }) {
  const queues = buildCleanWorkQueues(data, allowedRoute);
  const destinations: Record<string, string> = { waiting: "/messages", silent: "/messages", calls: "/calls", funnel: "/sources", publish: "/marketing", channels: "/settings?tab=channels", video: "/pipeline", attention: "/clients", returned: "/clients", delete: "/archive", team: "/team" };
  if (!queues.length) return null;
  return <section aria-label="Рабочие очереди" className="grid gap-4 min-[1180px]:grid-cols-2">
      <CHead title="Рабочие очереди" count={String(queues.length)} className="!mb-0 min-[1180px]:col-span-2" />
      {queues.map((queue) => {
        const Icon = QUEUE_ICONS[queue.id] ?? ClipboardCheck;
        const destination = allowedQueueHref(destinations[queue.id], allowedRoute);
        return <CCard key={queue.id} className="min-w-0 border-0">
          <div className="mb-4 flex items-center gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-blue/10 text-blue"><Icon size={22} aria-hidden /></span><div className="min-w-0 flex-1"><CHead title={queue.title} className="!mb-0" /></div><CChip tone="gray">{queue.total}</CChip></div>
          {queue.metrics && <QueueMetrics metrics={queue.metrics} />}
          <div className="grid gap-3">{queue.rows.slice(0, 3).map((row) => <VisualQueueRow key={row.id} row={row} photo={row.property ? propertyPhotos?.get(row.id) : undefined} />)}</div>
          <details className="mt-4 rounded-[14px] bg-row-alt p-3">
            <summary className="cursor-pointer text-[14px] font-semibold">Подробности{queue.rows.length > 3 ? ` · ещё ${queue.rows.length - 3}` : " и показатели"}</summary>
            {queue.detail && <div className="mt-3 text-[14px] leading-relaxed text-gray-600">{queue.detail}</div>}
            {queue.rows.slice(0, 3).filter((row) => row.detail).map((row) => <p key={row.id} className="mt-3 text-[14px] leading-relaxed text-gray-600"><b className="text-ink">{row.title}</b><br />{row.detail}</p>)}
            <div className="mt-3 grid gap-3">{queue.rows.slice(3).map((row) => <div key={row.id}><VisualQueueRow row={row} photo={row.property ? propertyPhotos?.get(row.id) : undefined} />{row.detail && <p className="mt-2 text-[14px] leading-relaxed text-gray-600">{row.detail}</p>}</div>)}</div>
          </details>
          {queue.id !== "video" && queue.total > queue.rows.length && <p className="mb-0 mt-3 text-[14px] text-gray-600">Доступных строк показано {queue.rows.length} из {queue.total}. Остальные подробности — в соответствующем разделе.</p>}
          {destination && <CLink className="mt-4" to={destination} variant="soft">Открыть раздел <ArrowUpRight size={18} aria-hidden /></CLink>}
        </CCard>;
      })}
    </section>;
}

const QUEUE_ICONS: Record<string, typeof ClipboardCheck> = { funnel: BarChart3, publish: Image, video: Clapperboard, attention: UserRound, team: Users, channels: Radio, calls: Phone, waiting: MessageSquare, silent: MessageSquare, returned: RotateCcw, delete: Trash2 };
function QueueMetrics({ metrics }: { metrics: NonNullable<QueueRow["metrics"]> }) {
  return <dl className="my-3 grid grid-cols-3 gap-3">{metrics.map((metric) => <div key={metric.label} className="min-w-0"><dt className="mt-1 text-[14px] leading-snug text-gray-600">{metric.label}</dt><dd className="m-0 text-[24px] font-semibold leading-tight tabular-nums text-ink">{metric.value}</dd></div>)}</dl>;
}
const SOURCE_ICONS: Record<string, typeof Globe> = { WEBSITE: Globe, REFERRAL: Handshake, GOOGLE_ADS: Megaphone, YANDEX_DIRECT: Megaphone, PHONE_CALL: Phone, WALK_IN: Footprints };
function VisualQueueRow({ row, photo }: { row: QueueRow; photo?: string }) {
  const [failedPhoto, setFailedPhoto] = useState<string>();
  const hasPhoto = !!photo && failedPhoto !== photo;
  const channel = row.channel ? channelMeta(row.channel) : null;
  const ChannelIcon = (row.channel ? SOURCE_ICONS[row.channel] : undefined) ?? channel?.icon ?? ClipboardCheck;
  const content = <>
    <div className="flex items-start gap-3">
      {row.person ? <CAvatar src={row.avatar} name={row.title} size={44} /> : row.property ? <div className="flex h-24 w-28 shrink-0 items-center justify-center rounded-[14px] bg-card"><>{hasPhoto ? <img src={photo} alt="" loading="lazy" decoding="async" onError={() => setFailedPhoto(photo)} className="h-full w-full rounded-[14px] object-cover" /> : <CleanPropertyIllustration size={80} />}</></div> : <span className={`flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-card ${channel?.tint ?? "text-blue"}`}><ChannelIcon size={22} aria-hidden /></span>}
      <div className="min-w-0 flex-1"><b className="block break-words text-[16px] font-semibold text-ink">{row.title}</b>{row.connected !== undefined && <CChip className="mt-2" tone={row.connected ? "ok" : "warn"}>{row.connected ? "Подключён" : "Не подключён"}</CChip>}{(row.context || !row.metrics && row.detail) && <p className="mb-0 mt-1 break-words text-[14px] leading-relaxed text-gray-600">{row.context ?? row.detail}</p>}{row.property && !hasPhoto && <p className="mb-0 mt-1 text-[14px] text-gray-500">{photo ? "Фото недоступно" : "Фото не передано в сводке"}</p>}</div>
      {row.href && <ArrowUpRight size={22} className="shrink-0 text-blue" aria-hidden />}
    </div>
    {row.metrics && <QueueMetrics metrics={row.metrics} />}
  </>;
  const style = "block min-w-0 rounded-[16px] bg-row-alt p-4 text-ink no-underline";
  return row.href ? <Link to={row.href} className={`${style} transition-colors hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-blue`}>{content}</Link> : <div className={style}>{content}</div>;
}

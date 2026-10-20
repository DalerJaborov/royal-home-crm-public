import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Check, ChevronDown, ExternalLink, Gauge, Loader2, Settings as SettingsIcon, UserCheck, XCircle } from "lucide-react";
import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_CHANNEL_FORMATS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  SOCIAL_VIDEO_LIMITS,
  destinationKey,
  formatBytesRu,
  formatDurationRu,
} from "@royal-home/shared";
import type {
  ChannelVerdict,
  SocialVideoAccountOption,
  SocialVideoChannel,
  SocialVideoChannelInfo,
  SocialVideoChannelLive,
  SocialVideoDestination,
} from "@royal-home/shared";
import {
  isAccountSelected,
  isAddressTaken,
  orderDestinations,
  selectableAccounts,
  toggleAccount,
  toggleChannel,
} from "../../lib/socialVideoDestinations";
import { ChannelBadge } from "./ChannelBadge";

/**
 * «Куда публиковать»: карточки шести сетей с галочкой, форматом на выходе,
 * живыми данными аккаунта, причинами отказа и правилами площадки.
 *
 * ВЫБРАТЬ МОЖНО ТОЛЬКО ТО, ЧТО РЕАЛЬНО УЙДЁТ: канал должен быть подключён
 * (`info.ready`), а ролик — не нарушать документированный предел площадки
 * (`verdict.level !== "BLOCK"`). Уже выбранный, но ставший непригодным канал
 * остаётся отключаемым, чтобы человек мог его снять.
 *
 * АККАУНТЫ (12.10.2026, «у нас два Instagram»): у канала с несколькими аккаунтами
 * под карточкой — список аккаунтов с галочками. Галочка на самом канале выбирает
 * аккаунт по умолчанию (`accountId: null`, как раньше), галочки аккаунтов — явные
 * адреса. Недоступный аккаунт не выбирается, причина написана рядом.
 * `lockedKeys` — адреса, которые уже есть у ролика (режим «добавить сеть или
 * аккаунт»): они показаны, но не выбираются.
 *
 * Живые данные (`live`) приходят медленно и отдельно, поэтому пока их нет,
 * карточка показывает заглушку, а не пустоту. Жалоба площадки на токен
 * (`live.problem`) — предупреждение, а не запрет: решает сервер, а ложная
 * тревога из-за сетевого сбоя не должна блокировать публикацию.
 */
export interface ChannelPickerProps {
  infos: SocialVideoChannelInfo[];
  live: Partial<Record<SocialVideoChannel, SocialVideoChannelLive>>;
  liveLoading: boolean;
  /** По выбранным и невыбранным — родитель считает на всех шести. */
  verdicts: ChannelVerdict[];
  selected: SocialVideoDestination[];
  onChange(next: SocialVideoDestination[]): void;
  disabled?: boolean;
  /** Ключи адресов (`destinationKey`), которые уже заняты и выбору не подлежат. */
  lockedKeys?: ReadonlySet<string>;
}

/** ГГГГ-ММ-ДД → ДД.ММ.ГГГГ. */
function ruDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

function QuotaLine({ live }: { live: SocialVideoChannelLive }) {
  const q = live.quota;
  if (!q) return null;
  const left = Math.max(0, q.remaining);
  const share = q.total > 0 ? left / q.total : 0;
  const empty = left === 0;
  const low = !empty && share <= 0.1;
  const tone = empty ? "text-red" : low ? "text-amber" : "text-gray-600";
  const barTone = empty ? "bg-red" : low ? "bg-amber" : "bg-green";
  return (
    <div className="flex flex-col gap-1">
      <p className={`m-0 flex items-center gap-1.5 text-[13px] font-semibold ${tone}`}>
        <Gauge size={14} aria-hidden="true" />
        Осталось публикаций сегодня: {left} из {q.total}
        {empty && " — лимит исчерпан"}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
    </div>
  );
}

function LiveBlock({ channel, info, live, loading }: { channel: SocialVideoChannel; info: SocialVideoChannelInfo | undefined; live: SocialVideoChannelLive | undefined; loading: boolean }) {
  if (!info?.ready) return null;
  if (!live) {
    return loading ? (
      <p className="m-0 flex items-center gap-2 text-[13px] text-gray-500" role="status">
        <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
        Проверяем аккаунт и лимиты у площадки…
      </p>
    ) : null;
  }
  const runtime = live.runtime;
  return (
    <div className="flex flex-col gap-1.5">
      {live.account && (
        <p className="m-0 flex items-center gap-1.5 text-[13px] text-gray-600">
          <UserCheck size={14} className="shrink-0 text-green" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Аккаунт: <b className="font-semibold text-gray-800">{live.account}</b>
          </span>
        </p>
      )}
      <QuotaLine live={live} />
      {channel === "TIKTOK" && runtime.maxDurationSec ? (
        <p className="m-0 text-[13px] text-gray-600">Лимит длины для вашего аккаунта (по данным TikTok): до {formatDurationRu(runtime.maxDurationSec)}</p>
      ) : null}
      {channel === "TELEGRAM" && runtime.maxSizeBytes ? (
        <p className="m-0 text-[13px] text-gray-600">Telegram принимает файлы до {formatBytesRu(runtime.maxSizeBytes)}</p>
      ) : null}
      {live.note && <p className="m-0 text-[13px] leading-snug text-gray-500">{live.note}</p>}
      {live.problem && (
        <p className="m-0 flex items-start gap-1.5 text-[13px] font-semibold leading-snug text-red">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          Площадка сообщает: {live.problem}
        </p>
      )}
    </div>
  );
}

function Rules({ channel, info }: { channel: SocialVideoChannel; info: SocialVideoChannelInfo | undefined }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const limits = info?.limits ?? SOCIAL_VIDEO_LIMITS[channel];
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${uid}-rules`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex! min-h-[36px]! items-center! gap-1! rounded-lg! px-1.5! text-[13px]! font-semibold! text-blue! hover:bg-blue/10!"
      >
        Лимиты и правила
        <ChevronDown size={15} className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={`${uid}-rules`} className="mt-1.5 flex flex-col gap-2 rounded-lg bg-ink/5 p-3">
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug text-gray-700">
            {limits.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {limits.dailyQuotaHint && <p className="m-0 text-[13px] leading-snug text-gray-600">Квота: {limits.dailyQuotaHint}</p>}
          {limits.sources.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {limits.sources.map((s) => (
                <li key={s.url}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] font-semibold text-blue underline-offset-2 hover:underline"
                  >
                    {s.title}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-[13px] text-gray-500">Сверено с документацией {ruDate(limits.verifiedAt)}</p>
        </div>
      )}
    </div>
  );
}

function AccountRow({
  account,
  checked,
  disabled,
  locked,
  onToggle,
}: {
  account: SocialVideoAccountOption;
  checked: boolean;
  disabled: boolean;
  locked: boolean;
  onToggle(): void;
}) {
  const uid = useId();
  const unavailable = !account.ready;
  const inputDisabled = disabled || locked || (unavailable && !checked);
  return (
    <li className={`rounded-lg border px-3 py-2 transition-colors ${checked ? "border-blue bg-blue/5" : "border-line bg-card-solid"}`}>
      <label htmlFor={`${uid}-acc`} className={`flex items-center gap-3 ${inputDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input id={`${uid}-acc`} type="checkbox" className="peer sr-only" checked={checked} disabled={inputDisabled} onChange={onToggle} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] font-semibold ${inputDisabled && !checked ? "text-gray-500" : "text-gray-800"}`}>
            <span className="min-w-0 break-words">{account.label}</span>
            {account.username && <span className="font-normal text-gray-500">@{account.username}</span>}
            {account.isDefault && <span className="rounded-full bg-ink/5 px-2 text-[13px] font-semibold text-gray-600">по умолчанию</span>}
          </span>
          {locked && <span className="text-[13px] text-gray-500">Уже в ролике</span>}
          {!locked && unavailable && (
            <span className="flex items-start gap-1.5 text-[13px] font-semibold leading-snug text-amber">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {account.problem ?? "Аккаунт недоступен"}
            </span>
          )}
        </span>
        <span
          aria-hidden="true"
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 transition-colors peer-focus-visible:shadow-[0_0_0_2px_rgb(var(--rgb-accent))] ${
            checked ? "border-blue bg-blue text-on-accent" : "border-gray-300 bg-card-solid text-transparent"
          } ${inputDisabled && !checked ? "opacity-50" : ""}`}
        >
          <Check size={14} strokeWidth={3} />
        </span>
      </label>
    </li>
  );
}

function ChannelCard({
  channel,
  info,
  live,
  liveLoading,
  verdict,
  checked,
  disabled,
  accounts,
  locked,
  allLocked,
  isAccountOn,
  isAccountLocked,
  onToggle,
  onToggleAccount,
}: {
  channel: SocialVideoChannel;
  info: SocialVideoChannelInfo | undefined;
  live: SocialVideoChannelLive | undefined;
  liveLoading: boolean;
  verdict: ChannelVerdict | undefined;
  checked: boolean;
  disabled: boolean;
  /** Аккаунты на выбор (пусто — у канала один аккаунт). */
  accounts: SocialVideoAccountOption[];
  /** Единственный адрес канала уже занят. */
  locked: boolean;
  /** Заняты все аккаунты канала. */
  allLocked: boolean;
  isAccountOn(a: SocialVideoAccountOption): boolean;
  isAccountLocked(a: SocialVideoAccountOption): boolean;
  onToggle(): void;
  onToggleAccount(a: SocialVideoAccountOption): void;
}) {
  const uid = useId();
  const label = SOCIAL_VIDEO_CHANNEL_LABELS[channel];
  const ready = info ? info.ready : false;
  const blocked = verdict?.level === "BLOCK";
  const selectable = ready && !blocked;
  const hasAccounts = accounts.length > 0;
  const inputDisabled = disabled || locked || allLocked || (!selectable && !checked);
  const format = verdict?.format ?? SOCIAL_VIDEO_CHANNEL_FORMATS[channel];

  const frame = checked ? "border-blue bg-blue/5" : "border-line bg-card-solid";

  return (
    <li className={`flex flex-col gap-2.5 rounded-card border p-3.5 transition-colors ${frame}`}>
      <label htmlFor={`${uid}-cb`} className={`flex items-center gap-3 ${inputDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input id={`${uid}-cb`} type="checkbox" className="peer sr-only" checked={checked} disabled={inputDisabled} onChange={onToggle} />
        <span className={selectable || checked ? "" : "opacity-55"}>
          <ChannelBadge channel={channel} size={40} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`text-[16px] font-semibold ${selectable || checked ? "text-gray-800" : "text-gray-500"}`}>{label}</span>
          <span className="text-[13px] text-gray-500">
            {ready ? (
              <>
                Выйдет как <b className="font-semibold text-gray-700">{format}</b>
                {(locked || allLocked) && " · уже в ролике"}
              </>
            ) : (
              "Не подключён"
            )}
          </span>
        </span>
        {/* Квадрат-галочка: состояние видно и без цвета — внутри значок. */}
        <span
          aria-hidden="true"
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 transition-colors peer-focus-visible:shadow-[0_0_0_2px_rgb(var(--rgb-accent))] ${
            checked ? "border-blue bg-blue text-on-accent" : "border-gray-300 bg-card-solid text-transparent"
          } ${inputDisabled && !checked ? "opacity-50" : ""}`}
        >
          <Check size={16} strokeWidth={3} />
        </span>
      </label>

      {ready && hasAccounts && (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[13px] font-semibold text-gray-600">Аккаунты: {accounts.length}</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label={`Аккаунты: ${label}`}>
            {accounts.map((a) => (
              <AccountRow
                key={a.id ?? "default"}
                account={a}
                checked={isAccountOn(a)}
                disabled={disabled || (blocked && !isAccountOn(a))}
                locked={isAccountLocked(a)}
                onToggle={() => onToggleAccount(a)}
              />
            ))}
          </ul>
          {checked && !accounts.some(isAccountOn) && <p className="m-0 text-[13px] text-gray-500">Уйдёт в аккаунт по умолчанию.</p>}
        </div>
      )}

      {!ready && (
        <div className="flex flex-col gap-2 rounded-lg bg-amber-bg px-3 py-2.5">
          <p className="m-0 text-[13px] font-semibold leading-snug text-amber">{info?.problem ?? "Канал не подключён"}</p>
          <Link
            to="/settings"
            className="inline-flex min-h-[36px] w-fit items-center gap-1.5 rounded-lg bg-card-solid px-3 text-[13px] font-semibold text-blue no-underline hover:bg-hover-tint"
          >
            <SettingsIcon size={14} aria-hidden="true" />
            Настройки → Каналы связи
          </Link>
        </div>
      )}

      {ready && verdict && verdict.blockers.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-lg bg-red-bg px-3 py-2.5 text-[13px] font-semibold leading-snug text-red">
          {verdict.blockers.map((b) => (
            <li key={b} className="flex items-start gap-1.5">
              <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="sr-only">Нельзя: </span>
                {b}
              </span>
            </li>
          ))}
        </ul>
      )}

      {ready && verdict && verdict.warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 rounded-lg bg-amber-bg px-3 py-2.5 text-[13px] leading-snug text-amber">
          {verdict.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="sr-only">Внимание: </span>
                {w}
              </span>
            </li>
          ))}
        </ul>
      )}

      <LiveBlock channel={channel} info={info} live={live} loading={liveLoading} />
      <Rules channel={channel} info={info} />
    </li>
  );
}

export function ChannelPicker({ infos, live, liveLoading, verdicts, selected, onChange, disabled = false, lockedKeys }: ChannelPickerProps) {
  const locked: ReadonlySet<string> = lockedKeys ?? new Set<string>();
  const infoOf = (c: SocialVideoChannel) => infos.find((i) => i.channel === c);
  const verdictOf = (c: SocialVideoChannel) => verdicts.find((v) => v.channel === c);
  const isSelectable = (c: SocialVideoChannel) => Boolean(infoOf(c)?.ready) && verdictOf(c)?.level !== "BLOCK";

  const accountsOf = (c: SocialVideoChannel) => selectableAccounts(infoOf(c));
  const accountLocked = (c: SocialVideoChannel, a: SocialVideoAccountOption) => isAddressTaken(locked, c, a);
  const channelLocked = (c: SocialVideoChannel) => accountsOf(c).length === 0 && locked.has(destinationKey(c, null));
  const channelAllLocked = (c: SocialVideoChannel) => {
    const accounts = accountsOf(c);
    return accounts.length > 0 && accounts.every((a) => accountLocked(c, a));
  };

  /**
   * Адрес, который встаёт при галочке на самом канале: аккаунт по умолчанию (`accountId: null`), а если он
   * занят или недоступен — первый свободный готовый аккаунт канала. null — выбирать нечего.
   */
  const defaultAddress = (c: SocialVideoChannel): SocialVideoDestination | null => {
    if (!isSelectable(c) || channelLocked(c)) return null;
    const accounts = accountsOf(c);
    if (accounts.length === 0) return { channel: c, accountId: null };
    const def = accounts.find((a) => a.isDefault);
    if (def && def.ready && !accountLocked(c, def)) return { channel: c, accountId: null };
    const free = accounts.find((a) => a.ready && !accountLocked(c, a));
    return free ? { channel: c, accountId: free.id } : null;
  };

  // «Выбрать все доступные»: по одному адресу на канал, где ещё ничего не выбрано.
  const available = SOCIAL_VIDEO_CHANNELS.filter((c) => defaultAddress(c) !== null);

  function selectAll() {
    const next = [...selected];
    for (const c of available) {
      const address = defaultAddress(c);
      if (address && !next.some((d) => d.channel === c)) next.push(address);
    }
    onChange(orderDestinations(next, infos));
  }

  function toggleCard(c: SocialVideoChannel) {
    if (selected.some((d) => d.channel === c)) {
      onChange(toggleChannel(selected, c, infos));
      return;
    }
    const address = defaultAddress(c);
    if (address) onChange(orderDestinations([...selected, address], infos));
  }

  if (infos.length === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label="Загружаем каналы">
        {SOCIAL_VIDEO_CHANNELS.map((c) => (
          <div key={c} className="h-[96px] rounded-card border border-line bg-ink/5 motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 mr-auto text-[14px] font-semibold text-gray-700" aria-live="polite">
          Выбрано адресов: {selected.length}
        </p>
        <button
          type="button"
          disabled={disabled || available.length === 0}
          onClick={selectAll}
          className="min-h-[40px]! rounded-full! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint! disabled:cursor-not-allowed! disabled:opacity-55!"
        >
          Выбрать все доступные
        </button>
        <button
          type="button"
          disabled={disabled || selected.length === 0}
          onClick={() => onChange([])}
          className="min-h-[40px]! rounded-full! border! border-line! bg-card-solid! px-3.5! text-[14px]! font-semibold! text-gray-800! hover:bg-hover-tint! disabled:cursor-not-allowed! disabled:opacity-55!"
        >
          Снять
        </button>
      </div>

      <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
        {SOCIAL_VIDEO_CHANNELS.map((c) => (
          <ChannelCard
            key={c}
            channel={c}
            info={infoOf(c)}
            live={live[c]}
            liveLoading={liveLoading}
            verdict={verdictOf(c)}
            checked={selected.some((d) => d.channel === c)}
            disabled={disabled}
            accounts={accountsOf(c)}
            locked={channelLocked(c)}
            allLocked={channelAllLocked(c)}
            isAccountOn={(a) => isAccountSelected(selected, c, a)}
            isAccountLocked={(a) => accountLocked(c, a)}
            onToggle={() => toggleCard(c)}
            onToggleAccount={(a) => onChange(toggleAccount(selected, c, a, infos))}
          />
        ))}
      </ul>
    </div>
  );
}

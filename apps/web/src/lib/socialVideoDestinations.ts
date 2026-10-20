import {
  SOCIAL_VIDEO_CHANNELS,
  SOCIAL_VIDEO_CHANNEL_LABELS,
  SOCIAL_VIDEO_COVER_PROVIDER_LABELS,
  SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER,
  destinationKey,
  destinationKeyOf,
  type ChannelVerdict,
  type SocialVideoAccountOption,
  type SocialVideoAiProvidersResponse,
  type SocialVideoChannel,
  type SocialVideoChannelInfo,
  type SocialVideoChannelResult,
  type SocialVideoCoverMeta,
  type SocialVideoCoverProvider,
  type SocialVideoDestination,
  type SocialVideoItem,
} from "@royal-home/shared";

/**
 * АДРЕСА «КАНАЛ + АККАУНТ» (12.10.2026, владелец: «у нас два Instagram»).
 *
 * Чистая логика выбора и подписей, без React: композитор, карточка ролика и список
 * считают адреса одинаково, а тесты проверяют это без отрисовки.
 *
 * Правила:
 *  - выбор канала без явных аккаунтов = адрес `accountId: null` («по умолчанию»), как раньше;
 *  - аккаунт, помеченный `isDefault`, и адрес `accountId: null` — один и тот же аккаунт;
 *  - у старых роликов `destinations` приходят с `accountId: null`, их результаты лежат под ключом без суффикса.
 */

const CHANNEL_ORDER = new Map<SocialVideoChannel, number>(SOCIAL_VIDEO_CHANNELS.map((c, i) => [c, i]));

/** Адреса «аккаунт по умолчанию» по списку каналов (так хранились ролики до выбора аккаунта). */
export function destinationsFromChannels(channels: readonly SocialVideoChannel[]): SocialVideoDestination[] {
  return channels.map((channel) => ({ channel, accountId: null }));
}

/** Адреса ролика; у ответа без `destinations` берём каналы с аккаунтом по умолчанию. */
export function destinationsOfItem(item: Pick<SocialVideoItem, "channels" | "destinations">): SocialVideoDestination[] {
  return item.destinations?.length ? item.destinations : destinationsFromChannels(item.channels);
}

/** Уникальные каналы адресов в едином порядке приложения. */
export function channelsOfDestinations(list: readonly SocialVideoDestination[]): SocialVideoChannel[] {
  const set = new Set(list.map((d) => d.channel));
  return SOCIAL_VIDEO_CHANNELS.filter((c) => set.has(c));
}

/** Порядок: сначала каналы как везде, внутри канала — как аккаунты в справочнике. */
export function orderDestinations(
  list: readonly SocialVideoDestination[],
  infos: readonly SocialVideoChannelInfo[] = []
): SocialVideoDestination[] {
  const accountIndex = (d: SocialVideoDestination): number => {
    const accounts = infos.find((i) => i.channel === d.channel)?.accounts ?? [];
    const idx = accounts.findIndex((a) => (d.accountId === null ? a.isDefault : a.id === d.accountId));
    return idx < 0 ? 0 : idx;
  };
  return [...list].sort(
    (a, b) => (CHANNEL_ORDER.get(a.channel) ?? 99) - (CHANNEL_ORDER.get(b.channel) ?? 99) || accountIndex(a) - accountIndex(b)
  );
}

export function sameDestinations(a: readonly SocialVideoDestination[], b: readonly SocialVideoDestination[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(destinationKeyOf));
  return b.every((d) => keys.has(destinationKeyOf(d)));
}

/** Аккаунты канала, из которых можно выбирать; пусто — выбора нет (один аккаунт). */
export function selectableAccounts(info: SocialVideoChannelInfo | undefined): SocialVideoAccountOption[] {
  return info && info.accounts && info.accounts.length > 1 ? info.accounts : [];
}

/** Выбран ли именно этот аккаунт: явным адресом или как «по умолчанию» (`accountId: null`). */
export function isAccountSelected(
  selected: readonly SocialVideoDestination[],
  channel: SocialVideoChannel,
  account: SocialVideoAccountOption
): boolean {
  return selected.some(
    (d) =>
      d.channel === channel &&
      (d.accountId === account.id || (d.accountId === null && account.isDefault) || (account.id === null && d.accountId === null))
  );
}

/** Адрес выбранного аккаунта: у аккаунта без id (единственный) — «по умолчанию». */
export function destinationOfAccount(channel: SocialVideoChannel, account: SocialVideoAccountOption): SocialVideoDestination {
  return { channel, accountId: account.id };
}

/** Включить/выключить аккаунт канала; `accountId: null` того же аккаунта заменяется явным адресом. */
export function toggleAccount(
  selected: readonly SocialVideoDestination[],
  channel: SocialVideoChannel,
  account: SocialVideoAccountOption,
  infos: readonly SocialVideoChannelInfo[]
): SocialVideoDestination[] {
  const isOn = isAccountSelected(selected, channel, account);
  const withoutThis = selected.filter(
    (d) =>
      !(
        d.channel === channel &&
        (d.accountId === account.id || (d.accountId === null && account.isDefault) || (account.id === null && d.accountId === null))
      )
  );
  if (isOn) return orderDestinations(withoutThis, infos);
  return orderDestinations([...withoutThis, destinationOfAccount(channel, account)], infos);
}

/** Галочка на самом канале: любой выбранный адрес канала снимается, иначе включается аккаунт по умолчанию. */
export function toggleChannel(
  selected: readonly SocialVideoDestination[],
  channel: SocialVideoChannel,
  infos: readonly SocialVideoChannelInfo[]
): SocialVideoDestination[] {
  if (selected.some((d) => d.channel === channel)) return selected.filter((d) => d.channel !== channel);
  return orderDestinations([...selected, { channel, accountId: null }], infos);
}

/** Название аккаунта адреса из справочника каналов; null — адрес «по умолчанию» без явного названия. */
export function accountLabelOf(d: SocialVideoDestination, infos: readonly SocialVideoChannelInfo[]): string | null {
  const accounts = infos.find((i) => i.channel === d.channel)?.accounts ?? [];
  if (d.accountId === null) {
    const def = accounts.find((a) => a.isDefault) ?? (accounts.length === 1 ? accounts[0] : undefined);
    return def?.label ?? null;
  }
  const found = accounts.find((a) => a.id === d.accountId);
  if (found) return found.label;
  // Аккаунта уже нет в справочнике — показываем хвост идентификатора, чтобы адреса различались.
  return `аккаунт ${d.accountId.slice(0, 6)}…`;
}

/** «Instagram · Royal Home Info»; без названия аккаунта — просто канал. */
export function destinationLabel(d: SocialVideoDestination, infos: readonly SocialVideoChannelInfo[]): string {
  const channel = SOCIAL_VIDEO_CHANNEL_LABELS[d.channel];
  // У канала с единственным аккаунтом (YouTube, TikTok, Threads, Facebook) название аккаунта ничего не добавляет:
  // не «Facebook · Facebook», а просто «Facebook».
  const accounts = infos.find((i) => i.channel === d.channel)?.accounts ?? [];
  if (accounts.length <= 1) return channel;
  const account = accountLabelOf(d, infos);
  return account && account !== channel ? `${channel} · ${account}` : channel;
}

/** Результат по адресу. Ключ — `destinationKey`; у старых роликов он без суффикса. */
export function resultOfDestination(
  results: SocialVideoItem["results"],
  d: SocialVideoDestination
): SocialVideoChannelResult | undefined {
  return results[destinationKeyOf(d)];
}

/** Адреса, у которых есть результат в нужном состоянии. */
export function destinationsInState(
  item: Pick<SocialVideoItem, "channels" | "destinations" | "results">,
  states: readonly SocialVideoChannelResult["state"][]
): SocialVideoDestination[] {
  return destinationsOfItem(item).filter((d) => {
    const r = resultOfDestination(item.results, d);
    return r !== undefined && states.includes(r.state);
  });
}

/** Повторить можно упавший или пропущенный адрес. */
export const RETRYABLE_STATES = ["FAILED", "SKIPPED"] as const;

/** Публикация прервана перезапуском сервера: пост мог уже выйти, повтор даст дубль. */
export function isInterruptedResult(r: SocialVideoChannelResult | undefined): boolean {
  return Boolean(r?.error && /оборвалась/i.test(r.error));
}

export const INTERRUPTED_RETRY_WARNING =
  "Пост мог уже выйти на площадке — проверьте и только потом повторяйте, иначе будет дубль.";

/** Адреса, которые ещё можно добавить к вышедшему ролику, — те, что не заняты (ключи в `taken`). */
export function isAddressTaken(taken: ReadonlySet<string>, channel: SocialVideoChannel, account: SocialVideoAccountOption | null): boolean {
  if (account === null) return taken.has(channel);
  return taken.has(destinationKey(channel, account.id)) || (account.isDefault && taken.has(channel));
}

/** Что мешает отправить выбранные адреса: канал не подключён, аккаунт недоступен, ролик не проходит правила. */
export function destinationBlockReasons(
  selected: readonly SocialVideoDestination[],
  infos: readonly SocialVideoChannelInfo[],
  verdicts: readonly ChannelVerdict[]
): string[] {
  const reasons: string[] = [];
  for (const d of selected) {
    const info = infos.find((i) => i.channel === d.channel);
    const label = destinationLabel(d, infos);
    if (info && !info.ready) reasons.push(`${label}: ${info.problem ?? "канал не подключён"}`);
    const account = info?.accounts?.find((a) => (d.accountId === null ? a.isDefault : a.id === d.accountId));
    if (info?.ready && account && !account.ready) reasons.push(`${label}: ${account.problem ?? "аккаунт недоступен"}`);
    for (const b of verdicts.find((v) => v.channel === d.channel)?.blockers ?? []) reasons.push(`${label}: ${b}`);
  }
  return reasons;
}

// ───────────────────────── обложка ИИ ─────────────────────────

/** Короткое имя провайдера: «Gemini (Google)» → «Gemini». */
export function coverProviderShortLabel(provider: SocialVideoCoverProvider): string {
  return SOCIAL_VIDEO_COVER_PROVIDER_LABELS[provider].replace(/\s*\(.*\)\s*$/, "");
}

/** «Нарисовано: Gemini · по кадру ролика · с трендами». */
export function coverMetaText(meta: SocialVideoCoverMeta): string {
  const parts = [coverProviderShortLabel(meta.provider)];
  if (meta.usedFrame) parts.push("по кадру ролика");
  if (meta.usedTrends) parts.push("с трендами");
  return `Нарисовано: ${parts.join(" · ")}`;
}

/** Выбранный провайдер с учётом доступности: недоступный заменяется доступным (по умолчанию — Gemini). */
export function effectiveProvider(
  providers: SocialVideoAiProvidersResponse | undefined,
  chosen: SocialVideoCoverProvider | null
): SocialVideoCoverProvider {
  const fallback = providers?.defaultProvider ?? SOCIAL_VIDEO_DEFAULT_COVER_PROVIDER;
  if (!providers) return chosen ?? fallback;
  const availableOf = (p: SocialVideoCoverProvider) => providers.providers.find((x) => x.provider === p)?.available === true;
  const wanted = chosen ?? fallback;
  if (availableOf(wanted)) return wanted;
  if (availableOf(fallback)) return fallback;
  return providers.providers.find((x) => x.available)?.provider ?? wanted;
}

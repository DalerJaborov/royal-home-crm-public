import type { ConversationFilters, InboxAccount } from "../../hooks/useConversations";
import { channelMeta } from "../../lib/channelMeta";

/** Presentation only: callbacks retain the inbox's existing filter semantics. */
export function CleanInboxFilters({ channels, accounts, channel, accountId, onChannelChange, onAccountChange }: {
  channels: string[];
  accounts: InboxAccount[];
  channel: ConversationFilters["channel"];
  accountId: ConversationFilters["accountId"];
  onChannelChange: (channel: ConversationFilters["channel"]) => void;
  onAccountChange: (accountId: ConversationFilters["accountId"]) => void;
}) {
  const account = accounts.find((item) => item.id === accountId);
  const summary = accountId
    ? account ? `${channelMeta(account.channel).label} · ${account.title}` : "Выбранный аккаунт"
    : channel ? channelMeta(channel).label : "Все каналы и аккаунты";
  return <details className="clean-inbox-filters">
    <summary>Канал и аккаунт <span>{summary}</span></summary>
    <div className="grid gap-3">
    <label className="grid gap-1.5 text-sm font-medium">
      Канал переписки
      <select className="inp !min-h-11 !w-full !max-w-none" value={channel ?? ""} onChange={(event) => {
        onChannelChange(event.target.value || undefined);
        onAccountChange(undefined);
      }}>
        <option value="">Все каналы</option>
        {channels.map((value) => <option value={value} key={value}>{channelMeta(value).label}</option>)}
      </select>
    </label>
    {(accounts.length > 1 || accountId) && <label className="grid gap-1.5 text-sm font-medium">
      Аккаунт компании
      <select className="inp !min-h-11 !w-full !max-w-none" value={accountId ?? ""} onChange={(event) => {
        onAccountChange(event.target.value || undefined);
        onChannelChange(undefined);
      }}>
        <option value="">Все аккаунты</option>
        {accountId && !accounts.some((account) => account.id === accountId) && <option value={accountId}>Выбранный аккаунт</option>}
        {accounts.map((account) => <option value={account.id} key={account.id}>{channelMeta(account.channel).label} · {account.title}</option>)}
      </select>
    </label>}
    </div>
  </details>;
}

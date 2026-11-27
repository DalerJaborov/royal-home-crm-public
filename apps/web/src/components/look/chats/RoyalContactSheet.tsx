import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, User, X } from "lucide-react";
import { contactCategoryLabel } from "@royal-home/shared";
import { CallClientButton } from "../../CallClientButton";
import { ContactProfilePanel } from "../../ContactProfilePanel";
import { ConversationClientLink } from "../../ConversationClientLink";
import { MutationError } from "../../MutationError";
import { SellerObjectStrip } from "../../chat/SellerObjectStrip";
import { useAcceptLead, useClient } from "../../../hooks/useClients";
import type { ConversationDetail, ConversationListItem, ConversationsPage } from "../../../hooks/useConversations";
import { dushanbeDayLabel } from "../../../lib/date";
import { relativeTime } from "../../../lib/format";
import { useAuthStore } from "../../../store/auth";
import { RhAvatar } from "../ui";
import { RoyalChannelBadge } from "./RoyalChannelBadge";
import { contactDetailRows, contactPrimaryAction, contactSecondaryActions } from "./contactSheet";

/** Строка этого чата из уже загруженного списка: оттуда имя по интересу, фото и «Что интересует» (в ответе одного диалога их нет). */
function useCachedListItem(conversationId: string): ConversationListItem | null {
  const queryClient = useQueryClient();
  return useMemo(() => {
    for (const [, page] of queryClient.getQueriesData<ConversationsPage>({ queryKey: ["conversations"] })) {
      if (!page || !Array.isArray(page.items)) continue;
      const found = page.items.find((item) => item.id === conversationId || item.sourceConversationIds?.includes(conversationId));
      if (found) return found;
    }
    return null;
  }, [queryClient, conversationId]);
}

/**
 * «СВЕДЕНИЯ О КОНТАКТЕ» по макету C (владелец 26–27.11.2026): крупная шапка (аватар как в списке чатов, имя или интерес,
 * канал), карточка «Что интересует», ОДНА главная кнопка и две вторичные, дальше «Что знает бот» и «Подробности»
 * свёрнутыми. Одно окно на всё: на телефоне занимает экран, на широком — колонка справа (раскладку держит
 * `.clean-conversation-workspace`). Ничего из прежнего не пропало — только сгруппировано и свёрнуто.
 */
export function RoyalContactSheet({ conversationId, conversation, title, code, channel, channelLabel, readOnly, isGroupedEntry, onClose }: {
  conversationId: string;
  conversation: ConversationDetail;
  title: string;
  code: string | null;
  channel: string | null | undefined;
  channelLabel: string;
  readOnly: boolean;
  isGroupedEntry: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const viewerId = useAuthStore((s) => s.agent?.id);
  const listItem = useCachedListItem(conversationId);
  const { data: client, isError: clientError, refetch: refetchClient } = useClient(conversation.clientId ?? undefined);
  const accept = useAcceptLead(conversation.clientId ?? "");

  const actionInput = {
    clientId: conversation.clientId,
    clientShortId: conversation.clientShortId,
    pendingAcceptance: !!client?.pendingAcceptance,
    canAccept: !!client && !readOnly && client.assignedAgentId === viewerId,
  };
  const primary = contactPrimaryAction(actionInput);
  const secondary = contactSecondaryActions({ ...actionInput, hasPhone: !!conversation.clientPhone, readOnly });

  const unnamed = !!listItem?.unnamed;
  const heroTitle = unnamed && listItem?.name ? listItem.name : title;
  const interest = listItem?.interest ?? null;
  const rows = contactDetailRows({
    code,
    profileName: conversation.profileName,
    phone: conversation.clientPhone,
    firstContact: relativeTime(conversation.firstContactAt),
    messagesCount: conversation.messages.length,
    subscriberId: conversation.subscriberId,
    hasDossier: !!conversation.contact,
    isGroupedEntry,
  });

  return (
    <div className="ry-csheet" data-testid="contact-sheet">
      <div className="ry-csheet-bar">
        <button type="button" className="ry-round ry-round-ghost" onClick={onClose} aria-label="Закрыть сведения о контакте"><X aria-hidden="true" /></button>
      </div>
      <header className="ry-csheet-hero">
        <span className="ry-chat-av">
          <RhAvatar name={heroTitle} src={listItem?.avatarUrl} seed={listItem?.avatarSeed} label={unnamed ? interest?.badge ?? undefined : undefined} size={96} />
          <RoyalChannelBadge channel={channel} />
        </span>
        <h2 className="clean-contact-title">{heroTitle}</h2>
        <p className="ry-csheet-sub">{channelLabel}</p>
      </header>

      {interest && (
        <section className="ry-csheet-want" aria-label="Что интересует">
          <span>Что интересует</span>
          <b>{interest.title}{interest.budget ? ` · ${interest.budget}` : ""}</b>
        </section>
      )}

      {/* Объект продавца и «Добавить объект» — тот же компонент и запрос, что раньше. */}
      <section className="ry-contact-object" aria-label="Объект"><SellerObjectStrip clientId={conversation.clientId} /></section>

      <div className="ry-csheet-actions">
        {primary?.kind === "accept" && (
          <button type="button" className="ry-csheet-primary" data-action="accept" disabled={accept.isPending} onClick={() => accept.mutate()}>
            <Check aria-hidden="true" />{accept.isPending ? "Принимаем…" : primary.label}
          </button>
        )}
        {primary?.kind === "card" && (
          <button type="button" className="ry-csheet-primary" data-action="card" onClick={() => navigate(`/clients/${primary.shortId}`)}>
            <User aria-hidden="true" />{primary.label}
          </button>
        )}
        {clientError && !client && (
          <p className="ry-csheet-note" role="status">
            Не удалось проверить, ждёт ли заявка принятия. <button type="button" className="lnk" onClick={() => void refetchClient()}>Повторить</button>
          </p>
        )}
        {accept.isError && <MutationError mutation={accept} fallback="Не удалось принять заявку" variant="rh2" />}
        {(secondary.call || secondary.card) && (
          <div className="ry-csheet-secondary">
            {secondary.call && conversation.clientPhone && (
              <CallClientButton clientId={conversation.clientId} phone={conversation.clientPhone} variant="full" label="Позвонить" className="ry-csheet-btn" />
            )}
            {secondary.card && conversation.clientShortId && (
              <button type="button" className="ry-csheet-btn" onClick={() => navigate(`/clients/${conversation.clientShortId}`)}>
                <User aria-hidden="true" />Карточка клиента
              </button>
            )}
          </div>
        )}
      </div>

      {!isGroupedEntry && <ConversationClientLink conversationId={conversationId} clientId={conversation.clientId} readOnly={readOnly} />}

      <div className="ry-csheet-acc">
        <details>
          <summary>
            <span>Что знает бот</span>
            <em>{conversation.contact ? contactCategoryLabel(conversation.contact.category) : "досье ещё нет"}<ChevronDown aria-hidden="true" /></em>
          </summary>
          <div className="clean-contact-profile" aria-label="Информация о клиенте">
            <ContactProfilePanel contact={conversation.contact} readOnly={readOnly} />
          </div>
        </details>
        <details>
          <summary>
            <span>Подробности</span>
            <em>телефон, даты<ChevronDown aria-hidden="true" /></em>
          </summary>
          <dl className="clean-contact-facts ry-csheet-facts">
            {rows.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>{row.key === "first" ? <time dateTime={conversation.firstContactAt} title={dushanbeDayLabel(conversation.firstContactAt)}>{row.value}</time> : row.value}</dd>
              </div>
            ))}
          </dl>
          {!isGroupedEntry && <p className="ry-csheet-note">Ссылка на профиль недоступна.</p>}
        </details>
      </div>
    </div>
  );
}

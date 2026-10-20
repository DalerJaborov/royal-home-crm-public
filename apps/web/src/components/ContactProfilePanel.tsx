/**
 * ЧТО БОТ ЗНАЕТ ПРО СОБЕСЕДНИКА — один экран на десктоп и на телефон.
 *
 * Досье бот читал перед каждым ответом ещё с 20.09, но показать его было негде:
 * владелец видел «бот ответил невпопад» и не мог проверить, что у бота в голове.
 * Панель печатает то же самое и теми же словами, что уходит в промт (значения
 * форматирует сервер — см. apps/api/src/lib/contactProfileView.ts), поэтому
 * расхождению между «что видит человек» и «что читает бот» взяться неоткуда.
 *
 * Компонент общий намеренно (правило CLAUDE.md «десктоп и телефон одной
 * задачей»): у мобильного близнеца MobileChatView своя вёрстка шапки и ленты, но
 * не своё досье — вторая копия этой панели разъехалась бы на первой же правке.
 */

import { useState } from "react";
import {
  CONTACT_CATEGORIES,
  CONTACT_FACT_DOMAINS,
  CONTACT_FACT_DOMAIN_LABELS,
  CONTACT_FACT_SOURCE_LABELS,
  contactCategoryLabel,
  type ContactCategory,
  type ContactProfileView,
} from "@royal-home/shared";
import { useSetContactCategory } from "../hooks/useContactProfile";
import { useCan } from "../lib/permissions";
import { channelMeta } from "../lib/channelMeta";
import { relativeTime } from "../lib/format";

const LANGUAGE_LABELS: Record<string, string> = {
  ru: "русский",
  tg: "таджикский",
  en: "английский",
};

/** Почему два досье предложены к слиянию — словами, а не кодом причины. */
const LINK_REASON_LABELS: Record<string, string> = {
  TRANSPORT_SPLIT: "один и тот же номер в разных каналах",
  STATED_PHONE: "назвал в переписке номер другого досье",
  NAME_AND_DIGITS: "совпали имя и хвост номера",
  USERNAME: "совпал ник",
};

export function ContactProfilePanel({ contact, readOnly = false }: { contact: ContactProfileView | null; readOnly?: boolean }) {
  const can = useCan();
  const setCategory = useSetContactCategory(contact?.id ?? null);
  const [categoryOpen, setCategoryOpen] = useState(false);

  /**
   * Досье нет — это не поломка, а возраст диалога: досье завели 20.09, и у тех,
   * кто писал раньше, его не будет, пока не пройдёт разбор прежних переписок.
   * Молчать здесь нельзя: пустое место читается как «бот ничего не знает», а на
   * самом деле он просто ещё не успел узнать.
   */
  if (!contact) {
    return (
      <div className="quiet">
        <span className="txt">
          Досье ещё нет: этот диалог начался раньше, чем бот стал вести карточку собеседника. Оно заведётся с
          первого же нового сообщения.
        </span>
      </div>
    );
  }

  const factDomains = CONTACT_FACT_DOMAINS.filter((d) => contact.facts[d].length > 0);
  const canEditCategory = can("messages.view") && !readOnly;

  return (
    <>
      <div className="quiet">
        <span className="txt">
          Бот считает: <b>{contactCategoryLabel(contact.category)}</b>
          {contact.categorySetAt ? ` (с ${relativeTime(contact.categorySetAt)})` : ""}.
        </span>
        {canEditCategory &&
          (categoryOpen ? (
            <select
              className="lnk"
              autoFocus
              defaultValue={contact.category}
              disabled={setCategory.isPending}
              onChange={(e) => {
                setCategory.mutate(e.target.value as ContactCategory);
                setCategoryOpen(false);
              }}
              onBlur={() => setCategoryOpen(false)}
              aria-label="Кто это на самом деле"
            >
              {CONTACT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {contactCategoryLabel(c)}
                </option>
              ))}
            </select>
          ) : (
            <button type="button" className="lnk" onClick={() => setCategoryOpen(true)}>
              Исправить
            </button>
          ))}
      </div>

      {setCategory.isError && (
        <div className="quiet">
          <span className="txt err">{(setCategory.error as Error).message}</span>
        </div>
      )}

      {/* Кем человек считался раньше. Прошлое не стирается по прямому решению
          владельца: сегодня продаёт, через месяц покупает — обе роли настоящие. */}
      {contact.categoryHistory.length > 1 && (
        <div className="quiet">
          <span className="txt">
            Раньше:{" "}
            {contact.categoryHistory
              .slice(1)
              .map((h) => `${contactCategoryLabel(h.category)} (${relativeTime(h.at)})`)
              .join(", ")}
            .
          </span>
        </div>
      )}

      <div className="quiet">
        <span className="txt">
          {contact.displayName ? (
            <>
              Зовут: <b>{contact.displayName}</b>
              {contact.nameSource === "self" ? " (назвал сам)" : ""}.{" "}
            </>
          ) : null}
          Пишет нам с <b>{relativeTime(contact.firstSeenAt)}</b>, всего <b>{contact.inboundMessages}</b> сообщений.
          {contact.language ? (
            <>
              {" "}
              Язык: <b>{LANGUAGE_LABELS[contact.language] ?? contact.language}</b>.
            </>
          ) : null}
        </span>
      </div>

      {/* Один человек — несколько переписок: ради этого досье и заводилось.
          Каналы показываем только тем, кому видно, откуда пришёл клиент. */}
      {contact.channels.length > 0 && contact.channels[0].channel !== null && (
        <div className="quiet">
          <span className="txt">
            Где писал:{" "}
            {contact.channels
              .map((c) => `${channelMeta(c.channel!).label} — ${c.conversations} ${plural(c.conversations)}`)
              .join(", ")}
            .
          </span>
        </div>
      )}

      {factDomains.length === 0 ? (
        <div className="quiet">
          <span className="txt">
            Бот пока ничего о нём не узнал — отвечает как незнакомому. Всё, что человек расскажет, появится здесь.
          </span>
        </div>
      ) : (
        factDomains.map((domain) => (
          <div className="quiet" key={domain}>
            <span className="txt">
              {CONTACT_FACT_DOMAIN_LABELS[domain]}:{" "}
              {contact.facts[domain].map((f, i) => (
                <span key={f.key}>
                  {i > 0 ? ", " : ""}
                  {f.label} <b title={`${CONTACT_FACT_SOURCE_LABELS[f.src]}, ${relativeTime(f.at)}`}>{f.value}</b>
                </span>
              ))}
            </span>
          </div>
        ))
      )}

      {/* Кандидаты на слияние: код их находит с 20.09, но подтвердить пока
          нечем — кнопки появятся вместе с экраном разбора. Молчать про них
          хуже: администратор хотя бы видит, что два досье — вероятно один
          человек, и что бот читает только одно из них. */}
      {contact.pendingLinks.length > 0 && (
        <div className="quiet">
          <span className="txt">
            Похоже, это тот же человек, что и{" "}
            {contact.pendingLinks
              .map(
                (l) =>
                  `${l.otherProfile.displayName ?? contactCategoryLabel(l.otherProfile.category).toLowerCase()} (${
                    LINK_REASON_LABELS[l.reason] ?? l.reason
                  })`
              )
              .join(", ")}
            . Пока досье не объединены, бот читает только это.
          </span>
        </div>
      )}
    </>
  );
}

function plural(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return "переписок";
  if (last === 1) return "переписка";
  if (last >= 2 && last <= 4) return "переписки";
  return "переписок";
}

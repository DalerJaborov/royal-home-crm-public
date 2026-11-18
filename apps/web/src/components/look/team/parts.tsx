import { useId, useState, type ReactNode } from "react";
import { ChevronRight, Info } from "lucide-react";
import { RoyalIcon } from "../RoyalIcon";
import { ROYAL_ICONS, type RoyalIconName } from "../royalIconData";
import { TEAM_EXTRA_ICONS, type TeamExtraIconName } from "./teamIconData";
import type { RhTone } from "../ui";

/**
 * ДЕТАЛИ ПАЧКИ «team» НОВОГО ВИДА (Команда, Настройки, «Ещё», меню профиля), 18.11.2026.
 *
 * Общие детали (круг, строка, плитка, переключатель) берутся из `../ui`; здесь
 * только то, чего там нет: значки сверх общего набора, кнопка «i» для пояснений
 * и подбор значка строки настроек по её названию. Оформление — в
 * theme-look-royal-team.css, только под `:root[data-ui-look="royal"]`.
 */
export type TeamIconName = RoyalIconName | TeamExtraIconName;

export function TeamIcon({ name, size = 24, filled = false }: { name: TeamIconName; size?: number; filled?: boolean }) {
  if (name in ROYAL_ICONS) return <RoyalIcon name={name as RoyalIconName} size={size} filled={filled} />;
  const icon = TEAM_EXTRA_ICONS[name as TeamExtraIconName];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
      // Static markup from the bundled icon set, never user data.
      dangerouslySetInnerHTML={{ __html: filled ? icon.fill : icon.line }} />
  );
}

/** Круг 48 со значком 24 — как RhCircle, но знает и дополнительные значки пачки. */
export function TeamCircle({ icon, tone = "a0", on }: { icon: TeamIconName; tone?: RhTone; on?: boolean }) {
  return (
    <span className="ry-circle" data-tone={tone} data-on={on === undefined ? undefined : String(on)} aria-hidden="true">
      <TeamIcon name={icon} />
    </span>
  );
}

export function RyChevron() {
  return <ChevronRight className="ry-chev" size={22} strokeWidth={2} aria-hidden="true" />;
}

/**
 * Кнопка «i»: пояснение-предложение не висит на экране, а открывается нажатием
 * (закон вида, разбор психолога 18.11). Сам текст остаётся в разметке — его
 * находит поиск по настройкам — и скрыт атрибутом `hidden` у владельца.
 */
export function useRyHint(label: string) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = (
    <button type="button" className="ry-info" aria-expanded={open} aria-controls={id}
      aria-label={open ? `Скрыть пояснение: ${label}` : `Пояснение: ${label}`} onClick={(event) => { event.stopPropagation(); setOpen((v) => !v); }}>
      <Info size={20} strokeWidth={2} aria-hidden="true" />
    </button>
  );
  return { open, id, button };
}

export function RyHintText({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  // data-ry-hint — единственная метка того, что можно спрятать под «i» (пояснение,
  // пришедшее отдельным пропом общей строки). Всё остальное видно всегда.
  return <span id={id} className="ry-hint" data-ry-hint="" hidden={!open}>{children}</span>;
}

/**
 * Значок строки настроек по её названию — тот же приём, что в макете
 * (`swIcon` в royal-home.src.html): первое совпавшее слово решает. Нет
 * совпадения — значок группы (передаёт вызывающий). Порядок важен: узкие слова
 * раньше общих («запись звонков» — микрофон, а не трубка).
 */
const BY_WORD: [RegExp, TeamIconName][] = [
  [/whats ?app/i, "message-circle"],
  [/instagram|facebook|meta|threads|tiktok|соцсет|публик/i, "send-horizontal"],
  [/telegram|телеграм/i, "send"],
  [/смс|sms/i, "send"],
  [/запис|голос|озвуч|диктов|речь|mic/i, "mic"],
  [/ноч/i, "moon"],
  [/язык|таджик|русск|перевод/i, "translate"],
  [/обращени|вежлив|«вы»/i, "hand"],
  [/комисс|процент|%|дол[яи]/i, "percent"],
  [/курс|доллар|деньг|сумм|расход|цен|бюджет|оплат/i, "banknote"],
  [/ролик|видео|рилс|reels|монтаж|обложк/i, "clapperboard"],
  [/реклам|продвиж|буст|кампан/i, "megaphone"],
  [/фото|картин|изображ/i, "image"],
  [/сайт|виджет|страниц/i, "globe"],
  [/бот|помощник|(^|[^а-яё])ии(?![а-яё])|модел|промт|ответ/i, "bot"],
  [/звон|телефон|атс|трубк|номер/i, "phone-call"],
  [/уведом|сводк|напомин|пуш|оповещ|сообщать/i, "bell-ring"],
  [/пауз|ожидан|ждёт|ждет|срок|час|врем|окн|минут|дн[яеи]/i, "clock"],
  [/лимит|скорост|порог/i, "gauge"],
  [/передач|переда|хозя|владел|перевод клиента|согласи/i, "user-switch"],
  [/рейтинг|балл|score|kpi|показател/i, "trend-up"],
  [/подбор|совпаден|радиус|район|ориентир|карт|адрес/i, "map-pin"],
  [/объект|квартир|дом(?![а-яё])|участ/i, "building-2"],
  [/клиент|лид|заявк|покупател/i, "inbox"],
  [/сотрудник|агент|команд|роп|менеджер/i, "users-round"],
  [/прав|доступ|безопас|подтвер|отпечат|парол|вход/i, "shield-check"],
  [/ключ|token|токен/i, "key"],
  [/ошибк|сбой|тревог|проблем/i, "circle-alert"],
  [/импорт|восстанов|резерв|архив|точк/i, "archive"],
  [/здоров|состояни|диагност|журнал/i, "gauge"],
  [/автомат|сразу|сам(?![а-яё])/i, "zap"],
  [/показ|видит|контрол/i, "eye"],
  [/компан|агентств|назван|логотип/i, "storefront"],
  [/интерфейс|оформлен|пульт|экран|тем[аы]/i, "layout-dashboard"],
];

export function settingsIconFor(text: string, fallback: TeamIconName = "settings"): TeamIconName {
  for (const [pattern, icon] of BY_WORD) if (pattern.test(text)) return icon;
  return fallback;
}

/** SVG значка как data:-адрес — для круга-маски у строк настроек без своего компонента. */
export function iconMaskUrl(name: TeamIconName): string {
  const body = name in ROYAL_ICONS ? ROYAL_ICONS[name as RoyalIconName].line : TEAM_EXTRA_ICONS[name as TeamExtraIconName].line;
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`)}")`;
}

/** Тон круга по названию: один и тот же пункт всегда одного цвета (не по номеру строки). */
export function toneFor(text: string): RhTone {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `a${hash % 6}` as RhTone;
}

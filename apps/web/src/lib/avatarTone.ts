import type { CSSProperties } from "react";

/**
 * ТОН АВАТАРА — ОДНО ПРАВИЛО НА ВСЮ CRM.
 *
 * Пять пар «пастельная подложка + насыщенный текст» из эталона «Royal Home 2026»
 * (`.av.lime|aqua|lav|pink|sky` в артефакте, токены `--lime`/`--lime-ink` и далее
 * в theme-2026-proto.css и в theme-2026-color-layer.css вне области `.rh2`).
 *
 * ЗАЧЕМ ОДИН МОДУЛЬ. К 11.09.2026 в apps/web было ЧЕТЫРЕ копии одной таблицы
 * тонов — lib/rh2Avatar.ts, lib/theme2026Person.ts, components/proto/protoAvatar.ts
 * и локальная палитра внутри components/mobile/MobileDeals.tsx — и три разных
 * правила выбора: хэш имени, порядковый номер строки и код первой буквы. Из-за
 * этого один и тот же человек был разного цвета в чатах и в команде, а в списках
 * с сортировкой и фильтрами менял цвет при каждом переупорядочивании. Здесь
 * правило одно, остальные модули оставлены тонкими обёртками ради своих
 * подписей и существующих мест вызова.
 *
 * ВЫБОР ТОНА ДЕТЕРМИНИРОВАН ИМЕНЕМ, а не позицией в списке: цвет — признак
 * человека, а не строки. Хэш и порядок тонов сохранены ровно те, что были в
 * lib/rh2Avatar.ts, чтобы у уже покрашенных списков (чаты, комментарии, поиск)
 * цвета не поехали.
 *
 * ЦВЕТА ЗАДАНЫ ТОКЕНАМИ, а не hex: ночная тема переопределяет обе половины пары,
 * поэтому одна запись работает в обеих темах и контраст проверяется один раз на
 * пару (см. apps/web/scripts/audit-color-layer-contrast.mjs).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Аватар клиента (components/ClientAvatar.tsx) в этот механизм не
 * входит намеренно: его палитра описана в packages/shared/src/clientAvatar.ts
 * явными hex, потому что ровно те же цвета сервер выводит в PNG для шторки
 * уведомлений, где никаких CSS-переменных нет.
 */

export type AvatarToneName = "pink" | "aqua" | "lime" | "sky" | "lav";

/** Порядок значим: он и есть отображение хэша в цвет. Менять — значит перекрасить
 *  всех людей в CRM разом. */
export const AVATAR_TONE_NAMES: readonly AvatarToneName[] = ["pink", "aqua", "lime", "sky", "lav"];

/** Пара токенов тона — для мест, которым нужны отдельные строки, а не стиль. */
export interface AvatarToneVars {
  bg: string;
  ink: string;
}

export function avatarToneVars(tone: AvatarToneName): AvatarToneVars {
  return { bg: `var(--${tone})`, ink: `var(--${tone}-ink)` };
}

/**
 * Устойчивый выбор тона по имени. Полином по основанию 31 с остатком 997 —
 * от хэша нужна не криптостойкость, а повторяемость: один и тот же человек
 * обязан быть одного цвета в списке чатов, в шапке диалога и в команде.
 */
export function avatarToneName(name: string | null | undefined): AvatarToneName {
  const s = name ?? "?";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return AVATAR_TONE_NAMES[h % AVATAR_TONE_NAMES.length];
}

/** Готовый инлайн-стиль для `.av`: подложка и цвет инициалов одной парой. */
export function avatarTone(name: string | null | undefined): CSSProperties {
  const tone = avatarToneName(name);
  return { background: `var(--${tone})`, color: `var(--${tone}-ink)` };
}

/**
 * Тона по порядку — для немногих мест, где цвет закреплён за ПОЗИЦИЕЙ, а не за
 * человеком (легенда графика, ряд заглушек одинаковой природы). Для людей
 * использовать `avatarTone(имя)`: список с сортировкой иначе перекрашивает людей
 * при каждом изменении порядка.
 */
export const AVATAR_TONE_STYLES: CSSProperties[] = AVATAR_TONE_NAMES.map((tone) => ({
  background: `var(--${tone})`,
  color: `var(--${tone}-ink)`,
}));

/* ---------- Мобильные списки по артефакту «телефон после» (11.09.2026) ---------- */

/** То же имя тона, но как ИМЯ КЛАССА для `.av.lime|aqua|lav|pink|sky` мобильного
 *  артефакта: там тон задан классом, и уголок канала внутри аватара (`.av .ch`)
 *  опирается на этот же класс. Хэш и порядок тонов общие с `avatarTone`, чтобы
 *  человек был одного цвета в чатах, в команде и в списке клиентов. */
export type AvatarTone = AvatarToneName;
export function avatarToneClass(name: string | null | undefined): AvatarTone {
  return avatarToneName(name);
}

/** Инициал для кружка: ОДНА буква, как в артефакте («Ф», «Р», «М», «@»). Ник из
 *  мессенджера начинается с «@» — его и показываем, иначе «@2» читалось бы как
 *  обрезанное имя. */
export function avatarInitial(name: string | null | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  return s[0].toUpperCase();
}

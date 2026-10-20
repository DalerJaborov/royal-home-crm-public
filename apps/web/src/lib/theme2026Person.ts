import type { CSSProperties } from "react";
import { AVATAR_TONE_STYLES } from "./avatarTone";

/**
 * Общие мелочи для людей в теме «Royal Home 2026».
 *
 * Тона аватара и правило присутствия заданы прототипом
 * (docs/pult/theme-2026/screens/team.html, _components.css): аватар красится
 * инлайновым стилем из пары токенов (`--aqua`/`--aqua-ink` и так далее), а
 * присутствие рисуется парой классов: кольцо на `.av` и точка `.pres` внутри.
 *
 * Один модуль на все экраны темы: копия этой таблицы в каждом файле
 * гарантированно разъехалась бы (правило «не дублировать» из CLAUDE.md).
 */
/**
 * Тона по ПОРЯДКУ — для мест, где цвет закреплён за позицией в ряду, а не за
 * человеком. Таблица одна на всю CRM (lib/avatarTone.ts): своя копия здесь уже
 * разошлась с тремя другими. Для человека правильнее `avatarTone(имя)` оттуда
 * же: список с сортировкой и фильтрами иначе перекрашивает людей при каждом
 * изменении порядка.
 */
export const AVATAR_TONES: CSSProperties[] = AVATAR_TONE_STYLES;

/** Инициалы для аватара без фото: те же две буквы, что были во всех списках CRM. */
export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface PresenceInput {
  online?: boolean;
  frozen?: boolean;
  isActive?: boolean;
  lastSeenAt?: string | null;
}

export interface PresenceClasses {
  /** Классы для самого аватара: `av ring`, `av ring warn`, `av ring off`. */
  avClass: string;
  /** Классы точки присутствия внутри аватара: `pres on`, `pres away`, `pres`. */
  dotClass: string;
}

/**
 * Присутствие по правилу прототипа:
 *   в сети            кольцо зелёное, точка `on`;
 *   был недавно       кольцо жёлтое, точка `away`;
 *   офлайн/заморожен  кольцо серое, точка без модификатора.
 */
export function presenceOf(person: PresenceInput): PresenceClasses {
  if (person.frozen || person.isActive === false) return { avClass: "av ring off", dotClass: "pres" };
  if (person.online) return { avClass: "av ring", dotClass: "pres on" };
  if (person.lastSeenAt) return { avClass: "av ring warn", dotClass: "pres away" };
  return { avClass: "av ring off", dotClass: "pres" };
}

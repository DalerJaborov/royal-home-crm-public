import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Font } from "@react-pdf/renderer";
import { dushanbeWallClock } from "../dushanbeTime.js";

/**
 * ОФОРМЛЕНИЕ PDF-ОТЧЁТОВ ROYAL HOME — одно место для шрифта, цветов и формата чисел.
 *
 * Шрифт — Onest, как во всей CRM (theme-2026-brand.css). Для PDF нужны
 * статические TTF целиком (в вебе лежат woff2, порезанные по наборам букв:
 * cyrillic и cyrillic-ext в разных файлах, а PDF-движок берёт один файл на
 * начертание). TTF с Google Fonts (лицензия OFL) в assets/fonts/report;
 * таджикские ӣ ӯ қ ғ ҳ ҷ в них есть — проверено при добавлении.
 */
const ASSETS = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets");
const FONTS = path.join(ASSETS, "fonts", "report");

/**
 * Логотип отдаётся движку байтами, а не путём: путь Windows «D:…» движок принимает
 * за адрес в интернете (схема «d:») и пытается его скачать. Читается один раз, лениво.
 */
let logos: { white: { data: Buffer; format: "png" }; green: { data: Buffer; format: "png" } } | null = null;
export function reportLogos() {
  logos ??= {
    white: { data: readFileSync(path.join(ASSETS, "report", "logo-white.png")), format: "png" },
    green: { data: readFileSync(path.join(ASSETS, "report", "logo-green.png")), format: "png" },
  };
  return logos;
}

let fontsReady = false;
export function ensureReportFonts(): void {
  if (fontsReady) return;
  Font.register({
    family: "Onest",
    fonts: [
      { src: path.join(FONTS, "Onest-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONTS, "Onest-Medium.ttf"), fontWeight: 500 },
      { src: path.join(FONTS, "Onest-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(FONTS, "Onest-Bold.ttf"), fontWeight: 700 },
      { src: path.join(FONTS, "Onest-ExtraBold.ttf"), fontWeight: 800 },
    ],
  });
  // У своего шрифта нет словарей переносов: без этого движок рвёт слова где попало.
  Font.registerHyphenationCallback((word) => [word]);
  fontsReady = true;
}

/** Синий акцент CRM (#1d5fe0, theme-2026-brand.css) и спокойная палитра вокруг. */
export const C = {
  accent: "#1d5fe0",
  accentDeep: "#0f3a95",
  accentSoft: "#eaf1fe",
  accentLine: "#c9dafb",
  ink: "#10131a",
  text: "#2b3140",
  muted: "#6b7385",
  line: "#e3e7ee",
  zebra: "#f7f9fc",
  good: "#16794a",
  goodSoft: "#e5f5ec",
  bad: "#b4232c",
  badSoft: "#fbe9ea",
  gray: "#b9c3d6",
  white: "#ffffff",
} as const;

/** «1 234 567» — пробел обычный: узкий неразрывный из toLocaleString есть не во всех PDF-просмотрщиках. */
export function num(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "−" : "";
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Деньги: с дирамами, когда они есть (ревью 14.11) — как экран (formatMoneyExact):
 * «33,33 с.», иначе сумма строк расходится с «Итого» на округление.
 */
export function money(value: number): string {
  const totalCents = Math.round(value * 100);
  const cents = Math.abs(totalCents) % 100;
  if (cents === 0) return `${num(totalCents / 100)} с.`;
  const whole = String(Math.trunc(Math.abs(totalCents) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${totalCents < 0 ? "−" : ""}${whole},${String(cents).padStart(2, "0")} с.`;
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value)} %`;
}

const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** «2026-11» → «Ноябрь 2026». */
export function monthTitle(key: string): string {
  const [y, m] = key.split("-").map(Number);
  const name = MONTHS_NOM[(m ?? 1) - 1] ?? key;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${y}`;
}

/** «2026-11» → «ноя». */
export function monthShort(key: string): string {
  const m = Number(key.split("-")[1]);
  return MONTHS_SHORT[m - 1] ?? key;
}

/** «2026-11-03» → «3 ноября 2026». */
export function dayTitle(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS_GEN[(m ?? 1) - 1] ?? ""} ${y}`;
}

/** Момент → «14 ноября 2026, 14:05» по Душанбе (UTC+5). */
export function dushanbeStamp(at: Date): string {
  const wall = dushanbeWallClock(at);
  const hh = String(wall.getUTCHours()).padStart(2, "0");
  const mm = String(wall.getUTCMinutes()).padStart(2, "0");
  return `${wall.getUTCDate()} ${MONTHS_GEN[wall.getUTCMonth()]} ${wall.getUTCFullYear()}, ${hh}:${mm}`;
}

/** Изменение к прошлому периоду, в процентах; null — сравнивать не с чем. */
export function deltaPercent(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

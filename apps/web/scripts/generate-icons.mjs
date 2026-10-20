import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * Иконки и экраны запуска для установленного приложения.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ ПОНАДОБИЛОСЬ. В манифесте и в index.html все иконки были одним
 * файлом icon.svg. Android с SVG в манифесте справляется через раз, а iOS формат
 * apple-touch-icon в SVG не поддерживает ВОВСЕ: при добавлении на домашний экран
 * iPhone рисует вместо логотипа уменьшенный скриншот страницы. То есть приложение,
 * которое человек установил, встречало его чужой картинкой — раньше, чем он успевал
 * что-то нажать (найдено при разборе мобильной версии 10.08.2026).
 *
 * ПОЧЕМУ СКРИПТОМ, А НЕ ФАЙЛАМИ В РЕПОЗИТОРИИ. Логотип живёт в одном месте —
 * public/icon.svg. Положи рядом восемь готовых PNG, и через месяц после смены
 * логотипа половина из них останется старой, причём заметит это только тот, кто
 * поставит приложение заново. Генерация из единственного источника такого расхождения
 * не допускает: `npm run icons` пересобирает всё.
 *
 * Запуск: npm run icons --workspace=apps/web
 */

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const source = join(publicDir, "icon.svg");

/** Фон экрана запуска и полей maskable-иконки — тот же, что background_color манифеста. */
const BACKGROUND = "#F7F8FA";
/** Синий логотипа: им заливается экран запуска, чтобы старт не мигал белым. */
const BRAND = "#2B59FF";

/**
 * Обычные иконки. 180 — apple-touch-icon (единственный размер, который читает iOS),
 * 192 и 512 — минимум, который требует установка на Android.
 */
const ICON_SIZES = [180, 192, 512];

/**
 * Maskable-иконка: Android обрезает её под форму, принятую в системе (круг, капля,
 * квадрат со скруглением). Обрезается до 20% с каждой стороны, поэтому рисунок
 * ужимается до 60% холста — иначе система срежет крышу у дома на логотипе.
 */
const MASKABLE_SIZE = 512;
const MASKABLE_SAFE_RATIO = 0.6;

/**
 * Экраны запуска iOS. Без них при открытии с домашнего экрана секунду висит белый
 * прямоугольник — самое заметное отличие установленного PWA от настоящего приложения.
 * Размеры — в пикселях устройства (логические × плотность), поэтому «1179×2556», а
 * не «393×852»: iOS подбирает файл по точному совпадению, промах означает белый экран.
 *
 * Список покрывает ходовые iPhone последних лет; остальные получат ближайший по
 * медиавыражению или обычный белый старт — это не поломка, а отсутствие украшения.
 */
/**
 * Значки ярлыков быстрых действий — меню по долгому нажатию на иконку
 * приложения (manifest.shortcuts в vite.config.ts).
 *
 * Логотип для них не годится: четыре одинаковых значка в списке отличаются
 * только подписью, и меню перестаёт читаться взглядом — а ради взгляда оно и
 * заведено. Поэтому у каждого ярлыка свой пиктограмный знак на фирменном синем.
 *
 * Рисунки — контуры в сетке 24×24 (та же геометрия, что у lucide-react в самом
 * интерфейсе), увеличенные вдвое и положенные по центру холста 96×96: именно
 * такой размер просит Android, и он же прилично выглядит в меню Windows.
 */
const SHORTCUT_ICON_SIZE = 96;
const SHORTCUT_ICONS = [
  {
    name: "shortcut-property.png",
    glyph: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  },
  {
    name: "shortcut-client.png",
    glyph:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  },
  {
    name: "shortcut-calendar.png",
    glyph:
      '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  },
  {
    name: "shortcut-messages.png",
    glyph: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  },
];

const SPLASH_SCREENS = [
  { name: "splash-1179x2556.png", width: 1179, height: 2556 }, // iPhone 15/16
  { name: "splash-1290x2796.png", width: 1290, height: 2796 }, // iPhone 15/16 Pro Max
  { name: "splash-1170x2532.png", width: 1170, height: 2532 }, // iPhone 12/13/14
  { name: "splash-1284x2778.png", width: 1284, height: 2778 }, // iPhone 12/13/14 Pro Max
  { name: "splash-828x1792.png", width: 828, height: 1792 }, // iPhone XR/11
  { name: "splash-750x1334.png", width: 750, height: 1334 }, // iPhone SE
];

async function renderIcons() {
  for (const size of ICON_SIZES) {
    const out = join(publicDir, `icon-${size}.png`);
    await sharp(source, { density: 384 }).resize(size, size).png().toFile(out);
    console.log(`icon-${size}.png`);
  }

  const inner = Math.round(MASKABLE_SIZE * MASKABLE_SAFE_RATIO);
  const padding = Math.round((MASKABLE_SIZE - inner) / 2);
  const logo = await sharp(source, { density: 384 }).resize(inner, inner).png().toBuffer();
  await sharp({
    create: {
      width: MASKABLE_SIZE,
      height: MASKABLE_SIZE,
      channels: 4,
      background: BRAND,
    },
  })
    .composite([{ input: logo, top: padding, left: padding }])
    .png()
    .toFile(join(publicDir, "icon-maskable-512.png"));
  console.log("icon-maskable-512.png");
}

async function renderShortcutIcons() {
  // Поля 24 с каждой стороны при рисунке 48×48: без них контур упирается в край
  // холста, а система ещё и скругляет угол — срезало бы крышу и края конверта.
  const svg = (glyph) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHORTCUT_ICON_SIZE}" height="${SHORTCUT_ICON_SIZE}" viewBox="0 0 ${SHORTCUT_ICON_SIZE} ${SHORTCUT_ICON_SIZE}">` +
    `<rect width="${SHORTCUT_ICON_SIZE}" height="${SHORTCUT_ICON_SIZE}" rx="22" fill="${BRAND}"/>` +
    `<g transform="translate(24 24) scale(2)" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>` +
    `</svg>`;

  for (const icon of SHORTCUT_ICONS) {
    await sharp(Buffer.from(svg(icon.glyph))).png().toFile(join(publicDir, icon.name));
    console.log(icon.name);
  }
}

async function renderSplashScreens() {
  for (const screen of SPLASH_SCREENS) {
    // Логотип — четверть ширины экрана: крупнее выглядит навязчиво, мельче теряется.
    const logoSize = Math.round(screen.width * 0.25);
    const logo = await sharp(source, { density: 384 }).resize(logoSize, logoSize).png().toBuffer();
    await sharp({
      create: { width: screen.width, height: screen.height, channels: 4, background: BACKGROUND },
    })
      .composite([
        {
          input: logo,
          top: Math.round((screen.height - logoSize) / 2),
          left: Math.round((screen.width - logoSize) / 2),
        },
      ])
      .png()
      .toFile(join(publicDir, screen.name));
    console.log(screen.name);
  }
}

/**
 * Теги <link rel="apple-touch-startup-image"> — их шесть штук с длинными
 * медиавыражениями, и держать их в index.html руками означает однажды разойтись со
 * списком выше. Печатаем готовый блок: если список экранов изменится, скрипт покажет,
 * что вставить.
 */
function printSplashLinks() {
  console.log("\nТеги для index.html (если список экранов менялся):");
  for (const s of SPLASH_SCREENS) {
    const ratio = s.width <= 828 ? 2 : 3;
    const w = Math.round(s.width / ratio);
    const h = Math.round(s.height / ratio);
    console.log(
      `<link rel="apple-touch-startup-image" href="/${s.name}" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${ratio})" />`
    );
  }
}

await mkdir(publicDir, { recursive: true });
await renderIcons();
await renderShortcutIcons();
await renderSplashScreens();
printSplashLinks();
await writeFile(
  join(publicDir, "icons-generated.txt"),
  // Отметка о том, чем и из чего собрано: иначе через полгода непонятно, можно ли
  // править эти PNG руками (нельзя — их перезапишет следующий запуск скрипта).
  "Файлы icon-*.png, shortcut-*.png и splash-*.png собраны scripts/generate-icons.mjs.\n" +
    "Руками не править — пересоберутся. icon-* и splash-* берут рисунок из icon.svg,\n" +
    "значки ярлыков заданы контурами в самом скрипте (SHORTCUT_ICONS).\n" +
    "Пересборка: `npm run icons --workspace=apps/web`.\n"
);
console.log("\nГотово.");

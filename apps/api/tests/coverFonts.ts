import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ШРИФТЫ ОБЛОЖЕК ПРОГОН БЕРЁТ ИЗ РЕПОЗИТОРИЯ, А НЕ ИЗ СИСТЕМЫ.
 *
 * `cover-templates.test.ts` сверяет отрисованную обложку по пикселям: цена
 * любой длины обязана поместиться в кремовую плашку. Ширину строки шаблон
 * считает ДО отрисовки, по метрикам из `src/lib/covers/coverMetrics.ts` (они
 * сгенерированы из таблицы `hmtx` самих TTF — librsvg метрики наружу не
 * отдаёт), а рисует sharp через librsvg тем шрифтом, который подставит
 * системный fontconfig. Совпадает это только там, где система реально знает
 * «TT Norms Pro» и «RH Playfair Lining».
 *
 * Не знает — fontconfig молча подставляет DejaVu Sans. Он шире, текст вылезает
 * за плашку, и проверка честно краснеет. То есть без этой настройки тест
 * проверяет не код, а установку шрифтов на машине, и красный он на ЛЮБОЙ
 * платформе, где их не поставили руками: в веб-сессии claude.ai/code, в свежем
 * клоне, у второго разработчика. Цена не одна красная проверка: `npm run ship`
 * вливает только при нуле падений в полном прогоне — значит с такой машины
 * нельзя влить вообще ничего серверного, и выглядит это как поломка `main`.
 *
 * Лечится без установки в систему. Шрифты и так лежат в репозитории
 * (`apps/api/assets/fonts/cover/`), а fontconfig умеет читать свой конфиг из
 * `FONTCONFIG_FILE`. Собираем на время прогона конфиг, который ДОБАВЛЯЕТ эту
 * папку к системным настройкам (`<include>` системного конфига, а не замена
 * его) — и прогон перестаёт зависеть от машины.
 *
 * Проверено 29.09.2026 на Linux: при снесённых системных копиях шрифтов
 * `fc-match "TT Norms Pro"` отдаёт DejaVuSans.ttf и файл даёт 33 из 34, а с
 * этим конфигом — TTNormsPro-Medium.ttf и 34 из 34, на том же коммите.
 * На Windows читает ли `FONTCONFIG_FILE` librsvg внутри sharp — отсюда
 * проверить нельзя, поэтому системный конфиг и системная папка шрифтов
 * остаются подключены: хуже, чем было, эта настройка там не сделает.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(here, "../assets/fonts/cover");

/** Пути fontconfig понимает через прямой слэш и на Windows тоже. */
const posix = (p: string): string => p.split(path.sep).join("/");

/**
 * Возвращает путь к конфигу fontconfig для прогона — или уже заданный снаружи.
 *
 * Заданный снаружи `FONTCONFIG_FILE` не трогаем: на машине владельца он свой,
 * и подменять чужую настройку молча — ровно тот класс, из-за которого это
 * всё и писалось.
 */
export function coverFontconfigFile(): string | undefined {
  if (process.env.FONTCONFIG_FILE) return process.env.FONTCONFIG_FILE;
  if (!fs.existsSync(fontsDir)) return undefined;

  /**
   * Системные шрифты Windows подключаются отдельной строкой и только там:
   * `WINDOWSFONTDIR` — особое слово fontconfig, и на Linux он честно ругается
   * на него как на двусмысленный путь. Системный конфиг Linux подключён
   * строкой выше и на Windows просто отсутствует (`ignore_missing`).
   */
  const systemDirs = process.platform === "win32" ? "\n  <dir>WINDOWSFONTDIR</dir>" : "";

  const cacheDir = path.join(os.tmpdir(), "royal-home-fontconfig-cache");
  const configPath = path.join(os.tmpdir(), "royal-home-fontconfig.conf");
  const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>${systemDirs}
  <dir>${posix(fontsDir)}</dir>
  <cachedir>${posix(cacheDir)}</cachedir>
</fontconfig>
`;

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    // Перезаписываем всегда: путь до репозитория у каждой копии свой, а файл
    // один на машину — от прошлого worktree он указывал бы не туда.
    fs.writeFileSync(configPath, xml);
  } catch {
    // Некуда писать — не повод валить весь прогон: без конфига красным будет
    // только `cover-templates.test.ts`, и его причина описана выше.
    return undefined;
  }
  return configPath;
}

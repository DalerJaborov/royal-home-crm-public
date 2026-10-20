/**
 * ГЕОЛОКАЦИЯ ПО ФОТО (EXIF GPS) — владелец 16.09.2026: «начну сейчас чтобы
 * работало». Разбор из docs/seller-card-and-listing-audit-15-09.md
 * («Геолокация по фото/видео — отсутствует полностью»): подключить парсер
 * EXIF, читать GPS из буфера при загрузке фото объекта, достраивать
 * координаты/район/адрес тем же путём, что уже работает для «закрытых»
 * объектов (координаты телефона агента, см. routes/properties/crud.ts).
 *
 * БИБЛИОТЕКА — `exif-reader`, а не более известный `exifr`. Зависимость уже
 * стояла в apps/api/package.json с 15.09.2026 (коммит 791be543, «заодно
 * установлена зависимость exif-reader — под следующий шаг: брать координаты»)
 * от параллельной сессии, но код так и не был написан. Ставить вторую
 * библиотеку для той же задачи рядом с уже приготовленной — плодить
 * зависимости без причины; `exif-reader` — ровно то, для чего его заводили,
 * и штатно работает в паре с уже используемым в проекте `sharp`
 * (`sharp().metadata()` отдаёт сырой буфер APP1-сегмента, `exif-reader` его
 * разбирает). Разница с `exifr` только в том, что `exif-reader` не переводит
 * GPS сам в десятичные градусы — эту часть (DMS → decimal) делает функция
 * ниже.
 */
import sharp from "sharp";
import exifReader from "exif-reader";

export interface PhotoGpsPoint {
  lat: number;
  lng: number;
}

/** [градусы, минуты, секунды] → десятичные градусы. EXIF всегда хранит GPS
 *  этой тройкой (см. GPSInfoTags.GPSLatitude в exif-reader/index.d.ts) —
 *  секунд/минут без градусов не бывает, а лишние элементы просто не встречаются. */
function dmsToDecimal(dms: number[]): number | null {
  if (dms.length < 3 || dms.some((n) => !Number.isFinite(n))) return null;
  const [deg, min, sec] = dms;
  return deg + min / 60 + sec / 3600;
}

/**
 * Координаты объекта из EXIF снимка — null, если тегов нет, файл без EXIF
 * (скриншот, мессенджер уже вырезал метаданные) или разбор упал. НИКОГДА не
 * бросает: вызывается на каждом загруженном фото, один битый файл не должен
 * ронять всю загрузку (тот же принцип, что и остальная обработка фото в
 * routes/properties/photos.ts — превью и миниатюра тоже не должны падать
 * из-за одного плохого снимка в пачке).
 *
 * Буфер — ОРИГИНАЛЬНЫЙ файл до `sharp().webp()`: перекодирование в WebP уже
 * не сохраняет EXIF, поэтому разбирать нужно `file.buffer` из multer, а не
 * то, что легло на диск.
 */
export async function extractGpsFromPhoto(buffer: Buffer): Promise<PhotoGpsPoint | null> {
  try {
    const { exif } = await sharp(buffer).metadata();
    if (!exif) return null;
    const tags = exifReader(exif);
    const gps = tags.GPSInfo;
    if (!gps?.GPSLatitude || !gps.GPSLongitude || !gps.GPSLatitudeRef || !gps.GPSLongitudeRef) return null;

    const latAbs = dmsToDecimal(gps.GPSLatitude);
    const lngAbs = dmsToDecimal(gps.GPSLongitude);
    if (latAbs === null || lngAbs === null) return null;

    const lat = gps.GPSLatitudeRef === "S" ? -latAbs : latAbs;
    const lng = gps.GPSLongitudeRef === "W" ? -lngAbs : lngAbs;

    // Санитарная проверка диапазона — повреждённый/нестандартный тег не должен
    // улететь координатой за пределы карты (тот же порядок величин, что
    // проверка на клиенте в LocationPicker.tsx).
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    // (0, 0) — классический признак отсутствующего/заглушечного GPS-тега
    // (Null Island), а не реальная точка в Душанбе — не подсовываем её как настоящую.
    if (lat === 0 && lng === 0) return null;
    // Точку вне Душанбе здесь НЕ режем — функция только разбирает EXIF как есть;
    // «объект в другом городе не бывает» решает вызывающий (routes/properties/
    // photos.ts, isInsideDushanbe из lib/geo.ts, 24.09.2026).

    return { lat, lng };
  } catch (err) {
    // Битый/нестандартный EXIF — не ошибка загрузки фото, просто нет геометки.
    // Не логируем через logSystemError: это ожидаемый, частый и безобидный
    // случай (большинство фото с мессенджеров/скриншотов EXIF не несёт),
    // шуметь в журнал ошибок на каждое такое фото не за чем.
    console.log(`[фото-гео] EXIF не разобран: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

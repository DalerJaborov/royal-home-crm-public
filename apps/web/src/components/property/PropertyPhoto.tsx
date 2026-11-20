import { useState, type CSSProperties } from "react";
import { ImageOff } from "lucide-react";

/**
 * ФОТО ОБЪЕКТА — ОДНА ДВЕРЬ НА ВСЕ ЭКРАНЫ (пачка D1 «экраны агента», 20.11.2026).
 *
 * Было пять своих `<img>` с фото объекта, и у каждого своя судьба при битой
 * ссылке (404 на хранилище, удалённый файл, сид стенда): каталог рисовал
 * «Фото недоступно», галерея — значок без слов, а подбор на карточке клиента —
 * значок битой картинки с alt-текстом на серой области около 1000×570
 * (critic-uiux.md, P0-5). Баг = класс: здесь правило одно для всех мест.
 *
 *  - пробует ссылки по очереди (полный размер → миниатюра или наоборот);
 *  - все не открылись — заглушка «Фото недоступно», ссылок нет вовсе — «Нет фото»;
 *  - коробка держит пропорцию сама (по умолчанию 4:3) и не шире `maxWidth`,
 *    поэтому картинка не растягивает карточку, чьей бы ни была вёрстка вокруг;
 *  - `fill` — коробку задаёт родитель (лента галереи, клетка плитки): фото на
 *    всю её площадь, пропорцию не навязываем.
 *
 * Сторож — `PropertyPhoto.guard.test.ts`: голый `<img>` с адресом фото объекта
 * вне этого файла не пропускается.
 */
export interface PropertyPhotoProps {
  /** Ссылки в порядке предпочтения; пустые и повторы отбрасываются. */
  sources: Array<string | null | undefined>;
  alt?: string;
  /** Пропорция коробки, CSS `aspect-ratio`. По умолчанию 4 / 3. */
  ratio?: string;
  /** Коробку задаёт родитель — фото на всю её площадь. */
  fill?: boolean;
  /** Маленькая миниатюра: заглушка только значком (подпись — для чтеца). */
  compact?: boolean;
  /** Предел ширины коробки (px); по умолчанию 480, у `fill` — без предела. */
  maxWidth?: number;
  className?: string;
  style?: CSSProperties;
  eager?: boolean;
  /**
   * Фото целиком по центру, а за ним то же фото размытое и затемнённое (как в каталогах). Нужно там, где рамка не
   * совпадает с пропорцией снимка: горизонтальное фото в высокой рамке иначе обрезается или тонет в чёрных полях
   * (кадр владельца с iPhone, 20.11.2026). Размытая копия — тот же адрес, браузер берёт его из кэша.
   */
  contain?: boolean;
}

export function photoCandidates(sources: PropertyPhotoProps["sources"]): string[] {
  return [...new Set(sources.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean))];
}

/** Текст заглушки: была ссылка, но не открылась — «недоступно»; ссылки не было — «нет». */
export function photoFallbackText(hadSource: boolean): string {
  return hadSource ? "Фото недоступно" : "Нет фото";
}

export function PropertyPhoto({
  sources,
  alt = "",
  ratio = "4 / 3",
  fill = false,
  compact = false,
  maxWidth,
  className,
  style,
  eager = false,
  contain = false,
}: PropertyPhotoProps) {
  const candidates = photoCandidates(sources);
  const key = candidates.join("|");
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key, count: 0 });
  const attempt = failed.key === key ? failed.count : 0;
  const source = candidates[attempt];
  const box: CSSProperties = fill
    ? { position: "relative", display: "flex", width: "100%", height: "100%", overflow: "hidden" }
    : { position: "relative", display: "flex", width: "100%", maxWidth: maxWidth ?? 480, aspectRatio: ratio, overflow: "hidden" };
  if (source) {
    return (
      <span className={className} style={{ ...box, ...style }} data-property-photo="">
        {contain && (
          <img
            src={source}
            alt=""
            aria-hidden="true"
            data-photo-backdrop=""
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            draggable={false}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(24px) brightness(0.55)", transform: "scale(1.2)" }}
          />
        )}
        <img
          src={source}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          style={{ position: "relative", width: "100%", height: "100%", objectFit: contain ? "contain" : "cover", display: "block" }}
          onError={() => setFailed({ key, count: attempt + 1 })}
        />
      </span>
    );
  }
  const text = photoFallbackText(candidates.length > 0);
  return (
    <span
      className={className}
      style={{
        ...box,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: "var(--rh-ui-raised, var(--soft))",
        color: "var(--rh-ui-hint, var(--faint))",
        textAlign: "center",
        ...style,
      }}
      data-property-photo="fallback"
      role="img"
      aria-label={alt ? `${alt}: ${text.toLowerCase()}` : text}
    >
      <ImageOff aria-hidden="true" style={{ width: compact ? 20 : 28, height: compact ? 20 : 28 }} />
      {!compact && <span className="rh-photo-text" style={{ fontSize: 14, lineHeight: 1.3, padding: "0 8px" }}>{text}</span>}
    </span>
  );
}

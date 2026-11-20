import {
  forwardRef, useCallback, useLayoutEffect, useRef, useState,
  type CSSProperties, type InputHTMLAttributes, type Ref,
} from "react";
import {
  ruFieldFormatHint, ruFieldText, supportsNativeField, wantsRuOverlay, type RuFieldKind,
} from "./ruFormat";

/**
 * ПОЛЯ ДАТЫ, МЕСЯЦА И ВРЕМЕНИ ПО-РУССКИ (20.11.2026, класс К01/К17 аудита, кадр владельца с iPhone).
 *
 * `RuDateField`, `RuMonthField`, `RuTimeField`, `RuDateTimeField` — замена голому
 * `<input type="date|month|time|datetime-local">`. Это тот же родной `<input>` (выбор остаётся системным,
 * `value`/`onChange`/`min`/`max`/`required` и всё остальное — как у обычного поля), но видимый текст всегда
 * по-русски: «20 ноября 2026», «Ноябрь 2026», «14:30», «20 ноября 2026, 14:30»; пустое — «Выберите дату».
 *
 * Два режима, выбираются один раз на первой отрисовке:
 *  - родное поле поддержано (и телефон, и компьютер): поле и наша подпись лежат в одной ячейке сетки
 *    (обёртка `grid`/`inline-grid`), родной текст прозрачный, подпись не перехватывает нажатия. Ни замеров,
 *    ни правок родителя: размер ячейки задаёт само поле. Шрифт и отступы подпись один раз берёт у поля.
 *    На компьютере, пока поле в фокусе, подпись прячется и виден родной текст — значение набирают по частям;
 *  - родного поля нет (Safari на Mac у `month`, старый Firefox): обычное текстовое поле с подсказкой формата.
 *
 * Пояс: значения — «стенные часы» без пояса, как у самих полей; в Душанбе их переводят
 * `dushanbeInputToIso`/`toLocalDateTimeInput` (`lib/date.ts`), «сегодня» и «сейчас» берут из
 * `dushanbeTodayKey()` — здесь ничего не пересчитывается. Для времени у поля `title` с поясом.
 *
 * Дальше по экранам брать ЭТИ поля, а не голый `<input type="date">`: сторож
 * `ruFieldsGuard.test.ts` не пропускает новое.
 */
type RuFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue"> & {
  /** Управляемое поле: значение держит экран. Либо defaultValue (поле без состояния, сохраняется на onBlur). */
  value?: string;
  defaultValue?: string;
  /** Выравнивание подписи: по умолчанию как у текста самого поля. */
  align?: "start" | "center";
  /** Поле в строке текста (а не отдельной строкой): обёртка `inline-grid`, а не блок. */
  inline?: boolean;
};

type Mode = "overlay" | "text";

const HIDDEN_NATIVE_TEXT: CSSProperties = { color: "transparent", WebkitTextFillColor: "transparent" };
/** Всегда: на фокусе меняется только цвет текста, а не вид поля, поэтому высота не прыгает. */
const PLAIN_APPEARANCE: CSSProperties = { WebkitAppearance: "none", appearance: "none" };

/** Вид текста поля, снятый один раз: подпись должна выглядеть как родной текст. */
interface Look {
  paddingLeft: string; paddingRight: string; textAlign: string;
  /** Шрифт поля одной строкой (`font`): подпись выглядит как родной текст, размер не пишем литералом. */
  font: string;
  /** Поле занимает всю ячейку (подпись тянется за ним) или уже её (подпись той же ширины, прижата влево). */
  fullWidth: boolean; width: number;
}

function readLook(input: HTMLInputElement): Look {
  const cs = getComputedStyle(input);
  const cell = input.parentElement?.getBoundingClientRect().width ?? 0;
  const width = input.getBoundingClientRect().width;
  return {
    fullWidth: cell > 0 && Math.abs(cell - width) < 2, width,
    paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, textAlign: cs.textAlign,
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`,
  };
}

function useMerged<T>(inner: React.MutableRefObject<T | null>, outer: Ref<T>) {
  return useCallback((node: T | null) => {
    inner.current = node;
    if (typeof outer === "function") outer(node);
    else if (outer) (outer as React.MutableRefObject<T | null>).current = node;
  }, [inner, outer]);
}

function makeField(kind: RuFieldKind) {
  const Field = forwardRef<HTMLInputElement, RuFieldProps>(function RuField(
    { value, defaultValue, align, inline, style, className, title, onChange, onFocus, onBlur, ...rest }, ref,
  ) {
    const [mode] = useState<Mode>(() => (supportsNativeField(kind) ? "overlay" : "text"));
    // Телефон и планшет: выбор колесом/окном, печатать нечем — подпись всегда. Компьютер: на время набора поле родное.
    const [touch] = useState(() => wantsRuOverlay());
    const inputRef = useRef<HTMLInputElement | null>(null);
    const setRef = useMerged(inputRef, ref);
    const [look, setLook] = useState<Look | null>(null);
    const [focused, setFocused] = useState(false);
    // Поле без состояния: подпись следует за тем, что выбрал человек.
    const [typed, setTyped] = useState(defaultValue ?? "");
    const controlled = value !== undefined;
    const shown = controlled ? value : typed;
    const valueProps = controlled ? { value } : { defaultValue };
    const handleChange: InputHTMLAttributes<HTMLInputElement>["onChange"] = (event) => {
      if (!controlled) setTyped(event.target.value);
      onChange?.(event);
    };

    // Один раз на вид поля (класс), не на каждый рендер и без наблюдателей за размером.
    useLayoutEffect(() => {
      if (mode !== "overlay" || !inputRef.current) return;
      setLook(readLook(inputRef.current));
    }, [mode, className]);

    const zoneTitle = title ?? (kind === "time" || kind === "datetime-local" ? "Время по Душанбе" : undefined);

    if (mode === "text") {
      const hint = ruFieldFormatHint(kind);
      return (
        <input
          {...rest} ref={setRef} type="text" inputMode="text" autoComplete="off" lang="ru" className={className} style={style}
          {...valueProps} onChange={handleChange} onFocus={onFocus} onBlur={onBlur}
          placeholder={rest.placeholder ?? hint.split(",")[0]} title={zoneTitle ?? hint}
        />
      );
    }

    const { text, empty } = ruFieldText(kind, shown);
    const revealed = focused && !touch;
    const { width: styleWidth, maxWidth, minWidth, flex, margin, ...inputStyle } = style ?? {};
    const centered = (align ?? (look?.textAlign === "center" ? "center" : "start")) === "center";
    return (
      <span
        className="ru-field"
        data-ru-field={kind}
        style={{
          display: inline ? "inline-grid" : "grid", gridTemplateColumns: "minmax(0, 1fr)", width: styleWidth, maxWidth,
          minWidth: minWidth ?? 0, flex, margin, verticalAlign: inline ? "middle" : undefined,
        }}
      >
        <input
          {...rest}
          ref={setRef}
          type={kind}
          lang="ru"
          className={className}
          title={zoneTitle}
          {...valueProps}
          onChange={handleChange}
          onFocus={(event) => { setFocused(true); onFocus?.(event); }}
          onBlur={(event) => { setFocused(false); onBlur?.(event); }}
          style={{
            ...inputStyle, gridArea: "1 / 1", justifySelf: "start", ...PLAIN_APPEARANCE, ...(revealed ? null : HIDDEN_NATIVE_TEXT),
            ...(styleWidth !== undefined ? { width: "100%" } : null),
          }}
        />
        <span
          aria-hidden="true"
          data-ru-field-text={kind}
          className="ru-field-text"
          data-empty={empty || undefined}
          style={{
            gridArea: "1 / 1", alignSelf: "stretch", justifySelf: look && !look.fullWidth ? "start" : "stretch", width: look && !look.fullWidth ? look.width : undefined,
            maxWidth: "100%", display: "flex", alignItems: "center",
            justifyContent: centered ? "center" : "flex-start", boxSizing: "border-box",
            visibility: revealed ? "hidden" : "visible", opacity: rest.disabled ? 0.55 : undefined,
            paddingLeft: look?.paddingLeft, paddingRight: look?.paddingRight, font: look?.font,
            pointerEvents: "none", zIndex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0,
            color: empty ? "var(--rh-ui-hint, var(--muted))" : "var(--rh-ui-text, var(--ink, currentColor))",
          }}
        >
          {text}
        </span>
      </span>
    );
  });
  Field.displayName = `Ru${kind === "datetime-local" ? "DateTime" : kind[0]!.toUpperCase() + kind.slice(1)}Field`;
  return Field;
}

export const RuDateField = makeField("date");
export const RuMonthField = makeField("month");
export const RuTimeField = makeField("time");
export const RuDateTimeField = makeField("datetime-local");

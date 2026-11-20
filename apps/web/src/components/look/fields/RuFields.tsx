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
 * `<input type="date|month|time|datetime-local">`. Это тот же родной `<input>` (выбор на
 * телефоне остаётся системным и удобным, `value`/`onChange`/`min`/`max`/`required` и всё
 * остальное — как у обычного поля), но видимый текст всегда по-русски:
 * «20 ноября 2026», «Ноябрь 2026», «14:30», «20 ноября 2026, 14:30»; пустое — «Выберите дату».
 *
 * Три режима, выбираются один раз на первой отрисовке:
 *  - телефон/планшет (touch или iPhone/iPad/Android в UA): родной текст поля прозрачный,
 *    рядом стоит наша подпись ровно поверх поля (размеры и шрифт берутся у самого поля) — она не
 *    перехватывает нажатия, и системный выбор открывается как раньше. Обёртки вокруг поля НЕТ: вёрстка
 *    экрана не меняется; родителю, если он не позиционирован, ставится `position: relative`;
 *  - компьютер: поле остаётся родным (значение набирают по частям, подпись поверх мешала бы),
 *    только `lang="ru"`;
 *  - браузер без родного поля (Safari на Mac у `month`, старый Firefox): обычное текстовое
 *    поле с подсказкой формата, а не «пустая коробка».
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
};

type Mode = "native" | "overlay" | "text";

function detectMode(kind: RuFieldKind): Mode {
  if (!supportsNativeField(kind)) return "text";
  return wantsRuOverlay() ? "overlay" : "native";
}

const HIDDEN_NATIVE_TEXT: CSSProperties = {
  color: "transparent", WebkitTextFillColor: "transparent", WebkitAppearance: "none", appearance: "none",
};

interface Box { left: number; top: number; width: number; height: number; paddingLeft: string; paddingRight: string;
  fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; textAlign: string }

function measure(input: HTMLInputElement): Box {
  const cs = getComputedStyle(input);
  return {
    left: input.offsetLeft, top: input.offsetTop, width: input.offsetWidth, height: input.offsetHeight,
    paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, fontFamily: cs.fontFamily, fontSize: cs.fontSize,
    fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, textAlign: cs.textAlign,
  };
}

function sameBox(a: Box | null, b: Box): boolean {
  return !!a && (Object.keys(b) as (keyof Box)[]).every((key) => a[key] === b[key]);
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
    { value, defaultValue, align, style, className, title, onChange, ...rest }, ref,
  ) {
    const [mode] = useState<Mode>(() => detectMode(kind));
    const inputRef = useRef<HTMLInputElement | null>(null);
    const setRef = useMerged(inputRef, ref);
    const [box, setBox] = useState<Box | null>(null);
    // Поле без состояния: подпись следует за тем, что выбрал человек.
    const [typed, setTyped] = useState(defaultValue ?? "");
    const controlled = value !== undefined;
    const shown = controlled ? value : typed;
    const valueProps = controlled ? { value } : { defaultValue };
    const handleChange: InputHTMLAttributes<HTMLInputElement>["onChange"] = (event) => {
      if (!controlled) setTyped(event.target.value);
      onChange?.(event);
    };

    // Подпись стоит ровно поверх поля: размеры, поля и шрифт берём у самого поля (экраны красят его по-своему).
    useLayoutEffect(() => {
      if (mode !== "overlay") return;
      const input = inputRef.current;
      if (!input) return;
      const parent = input.parentElement;
      const restore = parent && getComputedStyle(parent).position === "static" ? parent.style.position : null;
      if (parent && restore !== null) parent.style.position = "relative";
      const update = () => {
        const next = measure(input);
        setBox((prev) => (sameBox(prev, next) ? prev : next));
      };
      update();
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
      observer?.observe(input);
      return () => {
        observer?.disconnect();
        if (parent && restore !== null) parent.style.position = restore;
      };
    });

    const zoneTitle = title ?? (kind === "time" || kind === "datetime-local" ? "Время по Душанбе" : undefined);

    if (mode === "text") {
      const hint = ruFieldFormatHint(kind);
      return (
        <input {...rest} ref={setRef} type="text" inputMode="numeric" autoComplete="off" lang="ru" className={className} style={style}
          {...valueProps} onChange={handleChange} placeholder={rest.placeholder ?? hint.split(",")[0]} title={zoneTitle ?? hint} />
      );
    }

    if (mode === "native") {
      return <input {...rest} ref={setRef} type={kind} lang="ru" className={className} style={style} {...valueProps} onChange={handleChange} title={zoneTitle} />;
    }

    const { text, empty } = ruFieldText(kind, shown);
    const centered = (align ?? (box?.textAlign === "center" ? "center" : "start")) === "center";
    return (
      <>
        <input
          {...rest}
          ref={setRef}
          type={kind}
          lang="ru"
          className={className}
          title={zoneTitle}
          {...valueProps}
          onChange={handleChange}
          style={{ ...style, ...HIDDEN_NATIVE_TEXT }}
        />
        <span
          aria-hidden="true"
          data-ru-field-text={kind}
          data-empty={empty || undefined}
          style={{
            position: "absolute", left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0,
            display: "flex", alignItems: "center", justifyContent: centered ? "center" : "flex-start",
            boxSizing: "border-box", paddingLeft: box?.paddingLeft, paddingRight: box?.paddingRight,
            fontFamily: box?.fontFamily, fontSize: box?.fontSize, fontWeight: box?.fontWeight, lineHeight: box?.lineHeight,
            letterSpacing: box?.letterSpacing, pointerEvents: "none", zIndex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
            color: empty ? "var(--muted, rgba(120,120,128,.9))" : "var(--rh-ui-text, var(--ink, currentColor))",
          }}
        >
          {text}
        </span>
      </>
    );
  });
  Field.displayName = `Ru${kind === "datetime-local" ? "DateTime" : kind[0]!.toUpperCase() + kind.slice(1)}Field`;
  return Field;
}

export const RuDateField = makeField("date");
export const RuMonthField = makeField("month");
export const RuTimeField = makeField("time");
export const RuDateTimeField = makeField("datetime-local");

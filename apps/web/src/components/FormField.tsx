import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * Единые поля формы.
 *
 * ЗАЧЕМ. Каждая форма CRM верстала поля заново: где-то подпись 13px, где-то 12.5,
 * где-то её не было вовсе и смысл поля жил в подсказке внутри рамки (она исчезает,
 * стоит начать печатать). Из-за этого поля «разъезжались»: в форме клиента четыре
 * числа стояли в ряд, подпись «Этажность дома» переносилась на вторую строку, и
 * её поле оказывалось ниже соседних — выглядело сломанным.
 *
 * Здесь один компонент на все случаи: подпись всегда видна и всегда одной высоты,
 * подсказка под полем, ошибка рядом с самим полем (а не общим списком сверху),
 * на телефоне высота 44px — нижняя граница, ниже которой в поле не попасть пальцем.
 */

const BASE_INPUT =
  "w-full border rounded-lg px-3 text-[15px] outline-hidden transition-colors bg-card " +
  "min-h-11 py-2 md:min-h-0 md:py-2 disabled:opacity-60 disabled:bg-hover-tint";

function inputClass(invalid?: boolean): string {
  return `${BASE_INPUT} ${invalid ? "border-red focus:border-red" : "border-line focus:border-blue"}`;
}

interface FieldProps {
  label: string;
  /** Пояснение под полем: зачем поле нужно и что будет со значением. */
  hint?: string;
  /** Текст ошибки. Показывается вместо подсказки — два сообщения разом только мешают. */
  error?: string;
  required?: boolean;
  children: (props: { id: string; invalid: boolean; describedBy?: string }) => React.ReactNode;
}

/** Обёртка «подпись + поле + подсказка/ошибка». Поле рисует вызывающий код —
 *  так один компонент годится и для input, и для select, и для группы кнопок. */
export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-msg`;
  const invalid = !!error;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[15px] font-medium text-gray-700 mb-1.5 leading-tight">
        {label}
        {required && <span className="text-red"> *</span>}
      </label>
      {children({ id, invalid, describedBy: error || hint ? messageId : undefined })}
      {(error || hint) && (
        <p
          id={messageId}
          role={error ? "alert" : undefined}
          className={`mt-1 text-[13px] leading-snug ${error ? "text-red" : "text-gray-400"}`}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "className"> & { invalid?: boolean };

export function TextInput({ invalid, ...props }: InputProps) {
  return <input {...props} className={inputClass(invalid)} />;
}

/** Числовое поле. inputMode="numeric" — на телефоне открывается цифровая клавиатура,
 *  а не буквенная: бюджет и этаж набирают именно цифрами. */
export function NumberInput({ invalid, ...props }: InputProps) {
  return <input type="number" inputMode="numeric" {...props} className={inputClass(invalid)} />;
}

/** Код страны, который подставляется сам. Таджикистан — все номера агентства и
 *  почти все клиентские; для чужой страны код просто стирается и набирается свой. */
export const DEFAULT_DIAL_CODE = "+992";

/**
 * Поле телефона.
 *
 * ЗАЧЕМ. Агент набирал «+992» руками в каждой карточке — десять лишних нажатий на
 * телефоне, и половина номеров в базе оказывалась то с кодом, то без, то с восемёркой.
 * Теперь плюс в поле стоит всегда, а код страны подставляется сам при первом касании.
 * Жёстко он не зашит: три backspace — и набирается любой другой код.
 *
 * Всё, кроме цифр, отбрасывается на лету: скобки, дефисы и пробелы из скопированного
 * номера («+992 (93) 123-45-67») больше не доезжают до базы в таком виде.
 */
export const PhoneInput = forwardRef<HTMLInputElement, Omit<InputProps, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  /**
   * Собственный облик поля. InputProps намеренно запрещает className всем полям
   * формы — так они не разъезжаются по разделам. Здесь исключение ровно на один
   * случай: экран входа, где поле крупнее и живёт по своим меркам, а не по общим.
   */
  className?: string;
}>(function PhoneInput({
  value,
  onChange,
  invalid,
  // Свой облик поля — для экрана входа, где поле крупнее остальных форм. Раньше
  // className молча терялся: общий класс стоял ПОСЛЕ {...props} и затирал его.
  className,
  // Значением по умолчанию, а не жёстко в разметке ниже: раньше "tel" стояло
  // ПОСЛЕ {...props} и молча затирало то, что передал вызывающий код. Экран входа
  // просил "username" (чтобы менеджеры паролей узнавали форму входа) и не получал
  // его.
  autoComplete = "tel",
  ...props
}, ref) {
  return (
    <input
      {...props}
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete={autoComplete}
      value={value}
      // Пустое поле «оживает» кодом страны только когда в него встали: подставлять
      // код всем полям заранее нельзя — форма считалась бы изменённой, не будучи ею,
      // и закрытие спрашивало бы «данные будут потеряны» на ровном месте.
      onFocus={(e) => {
        if (!value.trim()) onChange(DEFAULT_DIAL_CODE);
        props.onFocus?.(e);
      }}
      // Вставка номера ЦЕЛИКОМ заменяет содержимое поля, а не дописывается к нему.
      // Без этого выходило так: человек ставит курсор в пустое поле — туда сам
      // подставляется «+992», — и вставляет из буфера «+992 90 000 00 00».
      // Получалось «+992992900000000», и номер уезжал в базу неверным. Поймано
      // e2e-прогоном 08.08.2026 на настоящем поле входа.
      onPaste={(e) => {
        const pasted = e.clipboardData.getData("text");
        // Вставляют «свой» номер целиком, только если в нём есть код страны или
        // он длиннее местного номера; короткий фрагмент дописывается как обычно.
        const digits = pasted.replace(/\D/g, "");
        if (pasted.trim().startsWith("+") || digits.length >= 9) {
          e.preventDefault();
          onChange(`+${digits}`);
        }
      }}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "");
        // Страховка на случай, когда код всё-таки задвоился (ручной набор поверх
        // подставленного, автозаполнение браузера): «992992…» — это не номер.
        const code = DEFAULT_DIAL_CODE.slice(1);
        const fixed = digits.startsWith(code + code) ? digits.slice(code.length) : digits;
        onChange(`+${fixed}`);
      }}
      className={className ?? inputClass(invalid)}
    />
  );
});

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className"> & { invalid?: boolean };

export function SelectInput({ invalid, children, ...props }: SelectProps) {
  return (
    <select {...props} className={`${inputClass(invalid)} appearance-none bg-no-repeat pr-8 cursor-pointer`}>
      {children}
    </select>
  );
}

/**
 * Свой выпадающий список — того же стекла/белого, что весь остальной интерфейс.
 *
 * ЗАЧЕМ. У обычного `<select>` открытый список рисует ОС/браузер напрямую —
 * CSS до него не достаёт вообще (владелец 18.08.2026, скриншот: список выглядел
 * голым системным меню посреди стеклянного интерфейса). Единственный способ
 * получить оформленный список — не открывать браузерный, а рисовать свой поверх
 * страницы. Компонент — не замена SelectInput везде разом (это отдельная большая
 * задача на все ~30 файлов с `<select>`), а образец для новых полей и точечных
 * правок там, где несовпадение стиля бросается в глаза сильнее всего.
 */
export function GlassSelect({
  id: idProp,
  value,
  onChange,
  options,
  invalid,
  ariaLabel,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  invalid?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`${inputClass(invalid)} flex items-center justify-between gap-2 text-left cursor-pointer`}
      >
        <span className={selected ? "" : "text-gray-400"}>{selected?.label ?? placeholder ?? "Выберите…"}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        // bg-card-solid, а НЕ bg-card + лишний backdrop-blur-xl: обычный --c-card и
        // так полупрозрачен (матовое стекло, index.css) — список вариантов просвечивал
        // сквозь содержимое под полем, а второй блюр сверху только смазывал текст.
        <div
          /* Роль — только когда варианты есть: список без единого `option`
             роняет axe `aria-required-children` (a11y, 10.09.2026). */
          role={options.length > 0 ? "listbox" : undefined}
          className="absolute z-30 mt-1.5 w-full max-h-64 overflow-y-auto rounded-2xl border border-line bg-card-solid py-1.5 shadow-lg"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-[15px] ${
                  active ? "font-semibold text-blue" : "text-ink hover:bg-hover-tint"
                }`}
              >
                {o.label}
                {active && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type TextAreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { invalid?: boolean };

export function TextArea({ invalid, ...props }: TextAreaProps) {
  return <textarea {...props} className={`${inputClass(invalid)} min-h-[84px] resize-none leading-snug`} />;
}

/**
 * Вариант ответа крупной кнопкой — основной способ отвечать в пошаговых формах.
 * Печатать агенту приходится ровно там, где без текста никак (имя, телефон,
 * свободные заметки); всё остальное выбирается нажатием, в том числе с телефона.
 */
export function Choice({
  active,
  onClick,
  children,
  title,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`min-h-11 rounded-lg border px-3 py-2 text-[15px] font-semibold transition-colors ${
        active ? "border-blue bg-blue/10 text-blue" : "border-line text-gray-700 hover:bg-hover-tint"
      }`}
    >
      {children}
    </button>
  );
}

/** Сетка вариантов. Колонок на телефоне меньше — иначе подписи вроде «5 и больше»
 *  переносятся и кнопки в ряду становятся разной высоты. */
export function ChoiceGrid({ cols = 2, children }: { cols?: 2 | 3; children: React.ReactNode }) {
  return <div className={`grid gap-2 ${cols === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"}`}>{children}</div>;
}

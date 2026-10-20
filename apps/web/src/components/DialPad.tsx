import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Delete, Phone } from "lucide-react";
import { formatLocalDialNumber, isDialable, LOCAL_NUMBER_LENGTH, toLocalDialDigits } from "@royal-home/shared";
import { useClients, useDialNumber } from "../hooks/useClients";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { LAST_DIAL_KEY } from "../lib/lastDial";

/**
 * НАБОРЩИК НОМЕРА — экран `dial` прототипа design_handoff (мобильный редизайн
 * 17.08.2026): светлый лист на фоне приложения, круглая «Назад», номер по
 * центру над клавиатурой, круглые клавиши с буквами, зелёная трубка 74px,
 * стирание справа от неё. Поведение — по README прототипа: тап по цифрам,
 * долгое нажатие на удаление стирает с ускорением (~85мс после задержки
 * ~420мс), «Вставить номер» видна только если в буфере реально номер,
 * автоопределение контакта по набранным цифрам.
 *
 * КОД СТРАНЫ ЖИВЁТ ОТДЕЛЬНО ОТ НОМЕРА — из-за этого и была жалоба владельца
 * («написано +992, продолжаю набирать — код исчезает»). Поле хранит только
 * цифры абонента, а `+992` нарисован слева ВСЕГДА и не стирается ничем.
 * По той же причине долгого нажатия «0 → +» из макета здесь нет: плюс с кодом
 * страны уже стоит на экране, вводить его не из чего и незачем.
 *
 * ПУТЬ ЗВОНКА ТЕПЕРЬ ОДИН — ЧЕРЕЗ СЕРВЕР, как у кнопок «Позвонить» на карточке
 * клиента и «Позвонить коллеге». Куда именно звонить сотруднику, решает станция
 * (`resolveAgentDialTarget`, apps/api/.../ariClient.ts) по настройке
 * `asteriskAgentDialMode`.
 *
 * До 18.08.2026 у наборщика была вторая дорога: если браузерная трубка (WebRTC)
 * в состоянии `ready`, он звонил ею напрямую через SIP.js, минуя сервер. Трубку
 * удалили вместе с рабочим местом оператора входящих (владелец 18.08.2026), и
 * дороги снова одна — что заодно снимает старый разъезд, когда один и тот же
 * набор номера уходил двумя разными путями и по-разному попадал в журнал.
 */

/** Клавиши как на телефоне: цифра + буквы, чтобы попадание было привычным. */
const KEYS: { digit: string; letters?: string }[] = [
  { digit: "1" },
  { digit: "2", letters: "ABC" },
  { digit: "3", letters: "DEF" },
  { digit: "4", letters: "GHI" },
  { digit: "5", letters: "JKL" },
  { digit: "6", letters: "MNO" },
  { digit: "7", letters: "PQRS" },
  { digit: "8", letters: "TUV" },
  { digit: "9", letters: "WXYZ" },
  { digit: "*" },
  { digit: "0", letters: "+" },
  { digit: "#" },
];


export function DialPadModal({ onClose }: { onClose: () => void }) {
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Кнопка «Вставить номер» — видна только если в буфере обмена РЕАЛЬНО лежит
  // телефонный номер (хендофф 17.08.2026: на телефоне Ctrl+V нет физически, а
  // клавиатурный `paste`-слушатель ниже работает только с внешней клавиатурой).
  // Читаем буфер один раз при открытии, без запроса нового жеста — если браузер
  // не даёт доступ без явного клика, просто не показываем кнопку.
  const [clipboardNumber, setClipboardNumber] = useState<string | null>(null);
  const dial = useDialNumber();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const boxRef = useRef<HTMLDivElement>(null);
  // Таймеры ускоряющегося стирания и флаг «длинное нажатие уже стёрло» —
  // чтобы click, который придёт следом за pointerup, не стирал лишнюю цифру.
  const delTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const longDeleteRanRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    navigator.clipboard
      ?.readText()
      .then((text) => {
        if (cancelled || !text) return;
        const local = toLocalDialDigits(text);
        if (local.length === LOCAL_NUMBER_LENGTH) setClipboardNumber(local);
      })
      .catch(() => {
        // Нет разрешения / буфер пуст / API недоступен — молча остаёмся без кнопки.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Таймеры не должны пережить закрытие наборщика.
  useEffect(
    () => () => {
      if (delTimeoutRef.current) clearTimeout(delTimeoutRef.current);
      if (delIntervalRef.current) clearInterval(delIntervalRef.current);
    },
    []
  );

  const pending = dial.isPending;
  /** Служебный код (*43) и внутренний номер (1006) — тоже законный набор. */
  const isService = digits.startsWith("*") || digits.startsWith("#");
  const canCall = isDialable(digits);

  const shown = useMemo(() => (isService ? digits : formatLocalDialNumber(digits)), [digits, isService]);

  /**
   * АВТООПРЕДЕЛЕНИЕ КОНТАКТА (README прототипа): от трёх набранных цифр ищем
   * клиента, чей номер начинается или кончается на набранное, — тем же
   * /clients?q=, которым ищет весь остальной интерфейс (сервер ищет и по
   * телефону). Показываем только клиентов с ЧИТАЕМЫМ номером: маскированный
   * (+992•••••57) не подставить в поле, и совпадение по огрызку цифр из маски
   * было бы враньём. Маскирование решает сервер — здесь ничего не открывается.
   */
  const debouncedDigits = useDebouncedValue(digits, 300);
  /**
   * ПОИСК ИДЁТ И НА ПОЛНОМ НОМЕРЕ (исправлено 22.08.2026, аудит раунд 5).
   *
   * Было `< LOCAL_NUMBER_LENGTH` — то есть ровно на той длине, где показывается
   * пометка «Нет в базе», поиск был ВЫКЛЮЧЕН и `match` всегда оставался null.
   * Оператор во время разговора видел «Нет в базе — Создать карточку» и для
   * давнего клиента тоже, заводил вторую карточку на тот же номер, и разговоры
   * по клиенту расползались по двум карточкам.
   */
  const lookupEnabled = !isService && debouncedDigits.length >= 3 && debouncedDigits.length <= LOCAL_NUMBER_LENGTH;
  const { data: lookupData, isError: lookupFailed, isFetching: lookupBusy } = useClients(
    { q: debouncedDigits, pageSize: 5 },
    lookupEnabled
  );
  /** Подсказка автодополнения: клиент, чей ПОЛНЫЙ номер начинается или кончается
   *  на набранное. Точное совпадение исключено намеренно — подставлять в поле
   *  ровно то, что там уже набрано, незачем (для него есть exactMatch ниже). */
  const match = useMemo(() => {
    if (!lookupEnabled || !lookupData) return null;
    for (const client of lookupData.items) {
      if (!client.phone || client.phone.includes("•")) continue;
      const local = toLocalDialDigits(client.phone);
      if (local.length !== LOCAL_NUMBER_LENGTH || local === debouncedDigits) continue;
      if (local.startsWith(debouncedDigits) || local.endsWith(debouncedDigits)) {
        return { name: client.fullName, local };
      }
    }
    return null;
  }, [lookupEnabled, lookupData, debouncedDigits]);

  /** Клиент с РОВНО этим номером уже заведён — тогда «Нет в базе» врёт. */
  const exactMatch = useMemo(() => {
    if (!lookupData) return null;
    for (const client of lookupData.items) {
      if (!client.phone || client.phone.includes("•")) continue;
      if (toLocalDialDigits(client.phone) === debouncedDigits) {
        return { name: client.fullName, shortId: client.shortId };
      }
    }
    return null;
  }, [lookupData, debouncedDigits]);

  /**
   * «Нет в базе» утверждаем ТОЛЬКО когда действительно спросили и получили
   * ответ: поиск закончен, не упал, и он про тот самый номер, что на экране.
   * Пока идёт запрос или он отказал — молчим, а не заявляем факт, которого не
   * знаем (тот же принцип, что у ключей: отказ ≠ «свободно»).
   */
  const answerIsKnown =
    lookupEnabled && !lookupBusy && !lookupFailed && !!lookupData && debouncedDigits === digits;

  /**
   * Клавиатура компьютера работает наравне с клавишами на экране: оператор
   * набирает номер, не отрывая рук, — а вставка из буфера (Ctrl+V) понимает
   * любой формат.
   */
  useEffect(() => {
    boxRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") return onClose();
      if (e.key === "Backspace") {
        setDigits((d) => d.slice(0, -1));
        return;
      }
      if (/^[0-9*#]$/.test(e.key)) setDigits((d) => (d + e.key).slice(0, 15));
    }
    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text) setDigits(toLocalDialDigits(text));
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [onClose]);

  /** Долгое нажатие на стирание: задержка ~420мс, дальше по цифре каждые ~85мс —
   *  ровно ритм наборщика из прототипа (dialBackDown). */
  function startLongDelete() {
    stopLongDelete();
    delTimeoutRef.current = setTimeout(() => {
      longDeleteRanRef.current = true;
      delIntervalRef.current = setInterval(() => {
        setDigits((d) => {
          const next = d.slice(0, -1);
          if (!next.length && delIntervalRef.current) clearInterval(delIntervalRef.current);
          return next;
        });
      }, 85);
    }, 420);
  }
  function stopLongDelete() {
    if (delTimeoutRef.current) clearTimeout(delTimeoutRef.current);
    if (delIntervalRef.current) clearInterval(delIntervalRef.current);
  }
  function handleDeleteClick() {
    // Длинное нажатие уже стёрло своё — click после pointerup не должен добавлять.
    if (longDeleteRanRef.current) {
      longDeleteRanRef.current = false;
      return;
    }
    setDigits((d) => d.slice(0, -1));
  }

  async function handleCall() {
    // Пустое поле — подставляем последний набранный, как в макете: второе
    // нажатие трубки его и наберёт.
    if (!digits) {
      const last = localStorage.getItem(LAST_DIAL_KEY);
      if (last) setDigits(last);
      return;
    }
    if (!canCall || pending) return;
    setError(null);
    stopLongDelete();
    try {
      // Серверу отдаём номер целиком: там своя нормализация, и «девять цифр»
      // без кода страны она поймёт иначе, чем человек.
      const full = isService || digits.length < 5 ? digits : `+992${digits}`;
      await dial.mutateAsync(full);
      localStorage.setItem(LAST_DIAL_KEY, digits);
      await queryClient.invalidateQueries({ queryKey: ["active-call"] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось позвонить");
    }
  }

  return (
    /* На телефоне — лист на весь экран на фоне приложения (var(--bg)), как экран
       `dial` макета; на широком — та же светлая карточка по центру поверх
       затемнения, чтобы наборщик «Телефонии» не расползался на весь монитор. */
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 backdrop-blur-xs sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Набор номера"
        className="flex w-full flex-col bg-bg text-ink outline-hidden sm:max-w-[390px] sm:rounded-[28px] sm:border sm:border-line sm:shadow-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: "calc(26px + env(safe-area-inset-bottom))" }}
      >
        {/* Шапка листа: круглая «Назад» 34px + заголовок 17px/700. */}
        <div className="flex flex-none items-center gap-[11px] px-4 pt-[14px]">
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть наборщик"
            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full bg-ink/8 active:scale-[0.94] transition-transform"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.9} />
          </button>
          <span className="min-w-0 flex-1 text-[17px] font-bold tracking-[-.02em]">Набор номера</span>
        </div>

        {/* Номер: снизу вверх — как в макете (колонка прижата к клавиатуре). */}
        <div className="flex min-h-[108px] flex-1 flex-col items-center justify-end gap-[7px] px-5 pb-2.5 pt-1.5">
          {clipboardNumber && !digits && (
            <button
              type="button"
              onClick={() => {
                setDigits(clipboardNumber);
                setClipboardNumber(null);
              }}
              className="px-2.5 py-1 text-[15px] font-semibold text-blue"
            >
              Вставить {formatLocalDialNumber(clipboardNumber)}
            </button>
          )}

          {digits ? (
            <div className="flex max-w-full items-baseline justify-center gap-2">
              {/* Код страны — отдельной меткой: его нельзя стереть, он не «исчезает». */}
              {!isService && <span className="flex-none text-[17px] font-semibold text-gray-400">+992</span>}
              <span
                className={`whitespace-nowrap font-semibold tracking-[.5px] tabular-nums ${
                  shown.length > 12 ? "text-[26px]" : "text-[31px]"
                }`}
              >
                {shown}
              </span>
            </div>
          ) : (
            <span className="text-[15px] font-medium text-gray-400">Введите номер</span>
          )}

          {/* Найденный контакт — белая пилюля с тенью: имя + номер; тап
              подставляет полный номер (dialMatch из макета). */}
          {match && (
            <button
              type="button"
              onClick={() => setDigits(match.local)}
              className="flex max-w-full items-center gap-[7px] rounded-full bg-card px-3 py-1.5 shadow-sm active:scale-[0.96] transition-transform"
            >
              <span className="min-w-0 truncate text-[15px] font-bold text-ink">{match.name}</span>
              <span className="flex-none text-[13px] font-semibold text-gray-400 tabular-nums">
                {formatLocalDialNumber(match.local)}
              </span>
            </button>
          )}

          {/**
           * «Нет в базе — создать карточку» (dialUnknownOn/dialNewClient
           * прототипа) — единственный кусок наборщика, которого у нас не было.
           * Живой случай: агент набирает номер с бумажки или из объявления,
           * разговаривает — и карточки по этому разговору не появляется, потому
           * что заводить её надо идти в другой раздел и вбивать номер заново.
           * Показываем только на ПОЛНОМ номере: на трёх цифрах «нет в базе» —
           * ещё не факт, а поиск просто не закончился.
           */}
          {/* Клиент найден по этому самому номеру — показываем, кто это, и
              открываем его карточку вместо предложения завести вторую. */}
          {!isService && exactMatch && digits.length === LOCAL_NUMBER_LENGTH && (
            <button
              type="button"
              onClick={() => navigate(`/clients/${exactMatch.shortId}`)}
              className="flex max-w-full items-center gap-[7px] rounded-full bg-card px-3 py-1.5 shadow-sm transition-transform active:scale-[0.96]"
            >
              <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{exactMatch.name}</span>
              <span className="flex-none text-[15px] font-bold text-blue">Открыть карточку</span>
            </button>
          )}

          {!isService && !match && !exactMatch && answerIsKnown && digits.length === LOCAL_NUMBER_LENGTH && (
            <button
              type="button"
              onClick={() => navigate(`/clients?new=1&phone=${encodeURIComponent(`+992${digits}`)}`)}
              className="flex max-w-full items-center gap-[7px] rounded-full bg-card px-3 py-1.5 shadow-sm transition-transform active:scale-[0.96]"
            >
              <span className="flex-none text-[15px] font-semibold text-gray-400">Нет в базе</span>
              <span className="flex-none text-[15px] font-bold text-blue">Создать карточку</span>
            </button>
          )}

          {/* Проверить не удалось — честно молчим о том, есть клиент или нет:
              «Нет в базе» здесь означало бы факт, которого мы не знаем. */}
          {!isService && lookupFailed && digits.length === LOCAL_NUMBER_LENGTH && (
            <p className="text-center text-[15px] text-gray-500">Не удалось проверить, есть ли клиент в базе</p>
          )}

          {error && <p className="text-center text-[15px] text-red">{error}</p>}
        </div>

        {/* Клавиатура: круглые клавиши, цифра 33px + буквы 9.5px с трекингом. */}
        <div className="grid flex-none grid-cols-3 justify-items-center gap-x-6 gap-y-3 px-[26px]">
          {KEYS.map((k) => (
            <button
              key={k.digit}
              type="button"
              onClick={() => setDigits((d) => (d + k.digit).slice(0, 15))}
              // Прототип: rgba(120,120,128,.14) / active .34 — было .08/.22, клавиши читались бледнее.
              className="flex aspect-square w-full max-w-[76px] flex-col items-center justify-center gap-0.5 rounded-full bg-ink/[.14] transition-colors active:bg-ink/34"
            >
              <span className="text-[33px] font-normal leading-[0.92] tracking-[-.01em]">{k.digit}</span>
              <span className="min-h-[10px] text-[13px] font-semibold leading-none tracking-[.16em] indent-[.16em]">
                {k.letters ?? ""}
              </span>
            </button>
          ))}
        </div>

        {/* Низ: трубка 74px строго по центру, стирание — справа от неё. */}
        <div className="grid flex-none grid-cols-[1fr_auto_1fr] items-center px-[30px] pt-3.5">
          <span />
          <button
            type="button"
            onClick={handleCall}
            disabled={pending || (!!digits && !canCall)}
            aria-label="Позвонить"
            className="grid h-[74px] w-[74px] place-items-center rounded-full bg-green text-white transition-transform active:scale-[0.93] disabled:opacity-40"
          >
            {pending ? (
              <span className="text-[15px] font-semibold">Звоним…</span>
            ) : (
              <Phone className="h-[31px] w-[31px]" strokeWidth={1.6} />
            )}
          </button>
          <span className="flex justify-start pl-3.5">
            {digits && (
              <button
                type="button"
                onClick={handleDeleteClick}
                onPointerDown={startLongDelete}
                onPointerUp={stopLongDelete}
                onPointerLeave={stopLongDelete}
                aria-label="Стереть цифру"
                className="grid h-[46px] w-[46px] place-items-center rounded-full text-ink transition-transform active:scale-90"
              >
                <Delete className="h-6 w-6" strokeWidth={1.6} />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

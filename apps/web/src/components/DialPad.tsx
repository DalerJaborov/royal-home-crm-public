import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Delete, Phone } from "lucide-react";
import { formatLocalDialNumber, isDialable, LOCAL_NUMBER_LENGTH, toLocalDialDigits } from "@royal-home/shared";
import { useClients, useDialNumber } from "../hooks/useClients";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { LAST_DIAL_KEY } from "../lib/lastDial";
import { Rh2Portal } from "./rh2/Rh2Scope";

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
    /* Окно живёт в области темы (`Rh2Portal`): прежние Tailwind-классы с
       полупрозрачным `bg-bg` (`--c-bg` = 60% альфы) пропускали страницу сквозь
       лист на телефоне — теперь фон листа непрозрачный `var(--page)`, подложка
       затемняет и размывает всё позади. На телефоне лист снизу (общее правило
       `[role="dialog"]` в index.css), на широком — карточка по центру. Облик
       клавиш и размеры прежние, правила — в theme-2026-dialpad.css. */
    <Rh2Portal>
      <div className="dp-back" onClick={onClose}>
        <div
          ref={boxRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Набор номера"
          className="dp"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Шапка листа: круглая «Назад» + заголовок 17px/700. */}
          <div className="dp-h">
            <button type="button" onClick={onClose} aria-label="Закрыть наборщик" className="dp-back-btn">
              <ChevronLeft className="dp-back-i" strokeWidth={1.9} aria-hidden="true" />
            </button>
            <span className="dp-title">Набор номера</span>
          </div>

          {/* Номер: снизу вверх — как в макете (колонка прижата к клавиатуре). */}
          <div className="dp-num">
            {clipboardNumber && !digits && (
              <button
                type="button"
                onClick={() => {
                  setDigits(clipboardNumber);
                  setClipboardNumber(null);
                }}
                className="dp-paste"
              >
                Вставить {formatLocalDialNumber(clipboardNumber)}
              </button>
            )}

            {digits ? (
              <div className="dp-line">
                {/* Код страны — отдельной меткой: его нельзя стереть, он не «исчезает». */}
                {!isService && <span className="dp-cc">+992</span>}
                <span className={`dp-digits${shown.length > 12 ? " sm" : ""}`}>{shown}</span>
              </div>
            ) : (
              <span className="dp-hint">Введите номер</span>
            )}

            {/* Найденный контакт — белая пилюля с тенью: имя + номер; тап
                подставляет полный номер (dialMatch из макета). */}
            {match && (
              <button type="button" onClick={() => setDigits(match.local)} className="dp-chip">
                <span className="dp-chip-n">{match.name}</span>
                <span className="dp-chip-m">{formatLocalDialNumber(match.local)}</span>
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
                className="dp-chip"
              >
                <span className="dp-chip-n">{exactMatch.name}</span>
                <span className="dp-chip-a">Открыть карточку</span>
              </button>
            )}

            {!isService && !match && !exactMatch && answerIsKnown && digits.length === LOCAL_NUMBER_LENGTH && (
              <button
                type="button"
                onClick={() => navigate(`/clients?new=1&phone=${encodeURIComponent(`+992${digits}`)}`)}
                className="dp-chip"
              >
                <span className="dp-chip-m">Нет в базе</span>
                <span className="dp-chip-a">Создать карточку</span>
              </button>
            )}

            {/* Проверить не удалось — честно молчим о том, есть клиент или нет:
                «Нет в базе» здесь означало бы факт, которого мы не знаем. */}
            {!isService && lookupFailed && digits.length === LOCAL_NUMBER_LENGTH && (
              <p className="dp-note">Не удалось проверить, есть ли клиент в базе</p>
            )}

            {error && <p className="dp-note err">{error}</p>}
          </div>

          {/* Клавиатура: круглые клавиши, цифра 33px + буквы с трекингом. */}
          <div className="dp-keys">
            {KEYS.map((k) => (
              <button
                key={k.digit}
                type="button"
                onClick={() => setDigits((d) => (d + k.digit).slice(0, 15))}
                className="dp-key"
              >
                <span className="dp-key-d">{k.digit}</span>
                <span className="dp-key-l">{k.letters ?? ""}</span>
              </button>
            ))}
          </div>

          {/* Низ: трубка 74px строго по центру, стирание — справа от неё. */}
          <div className="dp-bot">
            <span />
            <button
              type="button"
              onClick={handleCall}
              disabled={pending || (!!digits && !canCall)}
              aria-label="Позвонить"
              className="dp-call"
            >
              {pending ? (
                <span className="dp-call-t">Звоним…</span>
              ) : (
                <Phone className="dp-call-i" strokeWidth={1.6} aria-hidden="true" />
              )}
            </button>
            <span className="dp-del-slot">
              {digits && (
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  onPointerDown={startLongDelete}
                  onPointerUp={stopLongDelete}
                  onPointerLeave={stopLongDelete}
                  aria-label="Стереть цифру"
                  className="dp-del"
                >
                  <Delete className="dp-del-i" strokeWidth={1.6} aria-hidden="true" />
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    </Rh2Portal>
  );
}

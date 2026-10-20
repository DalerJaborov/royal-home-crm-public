/**
 * Отправка ссылки через системное меню «Поделиться» (Web Share API).
 *
 * ЗАЧЕМ. Агент показывает объект и тут же скидывает его клиенту в WhatsApp. До
 * этого он копировал адрес из строки браузера — в установленном приложении
 * строки браузера НЕТ вовсе, и скопировать ссылку было физически неоткуда.
 *
 * Единственная из «новых» возможностей PWA, которая работает у всех: и в Chrome
 * на Android, и в Safari на iPhone, и на компьютере. Поэтому она и сделана
 * первой — остальные (значок на иконке, ярлыки) часть людей просто не увидит.
 *
 * ⚠️ ВЫЗЫВАТЬ ТОЛЬКО ИЗ ОБРАБОТЧИКА НАЖАТИЯ И БЕЗ `await` ПЕРЕД ЭТИМ.
 * Браузер отдаёт системное меню лишь пока «жив след» нажатия человека
 * (transient activation). Любой `await` до вызова — и след истекает, а
 * `navigator.share` отказывает с NotAllowedError. Поэтому `navigator.share`
 * стоит первой строкой функции: всё, что нужно посчитать (цену, адрес),
 * считается ДО вызова, у вызывающего.
 */

export interface ShareContent {
  /** Заголовок системного окна. Мессенджеры его игнорируют — важен text. */
  title: string;
  /** Что уйдёт вместе со ссылкой: цена, район, комнаты. */
  text?: string;
  url: string;
}

export type ShareResult =
  /** Ушло в системное меню — человек выбрал приложение. */
  | "shared"
  /** Системного меню нет: ссылка легла в буфер обмена. */
  | "copied"
  /** Человек закрыл системное меню. Это НЕ ошибка — ругаться нельзя. */
  | "cancelled"
  /** Не получилось ни то ни другое. */
  | "failed";

/** Есть ли системное меню. Ложь на десктопном Firefox и в старых WebView —
 *  там сработает запасной путь через буфер обмена, кнопку прятать не нужно. */
export function canNativeShare(): boolean {
  return typeof navigator.share === "function";
}

export async function shareOrCopy(content: ShareContent): Promise<ShareResult> {
  const data: ShareData = { title: content.title, text: content.text, url: content.url };

  // canShare есть не везде, где есть share (старый Android): его отсутствие —
  // не повод не пытаться, поэтому проверяем только когда он реально объявлен.
  const shareable = typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare(data));

  if (shareable) {
    try {
      await navigator.share(data);
      return "shared";
    } catch (err) {
      // Закрыл меню — молча выходим: показывать «не удалось» на осознанное
      // действие человека значит обвинять его в собственном решении.
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      // Остальные отказы (NotAllowedError, отсутствие приложений-получателей)
      // не тупик: ссылку всё ещё можно положить в буфер.
    }
  }

  return (await copyText(content.url)) ? "copied" : "failed";
}

/**
 * Буфер обмена. Современный API работает только в защищённом контексте (https
 * или localhost) — на dev-сервере, открытом с телефона по адресу вида
 * http://192.168.x.x, его нет. Поэтому за ним стоит старый execCommand: он
 * объявлен устаревшим, но остаётся единственным способом скопировать текст
 * по незащищённому адресу, и именно так CRM смотрят с телефона при отладке.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Отказано в доступе к буферу — пробуем старый способ ниже.
  }

  const area = document.createElement("textarea");
  area.value = text;
  // Вне экрана, но НЕ display:none и не hidden: невидимый элемент нельзя
  // выделить, а без выделения копировать нечего.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

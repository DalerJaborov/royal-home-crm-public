/**
 * «Занят прямо сейчас» — используется `UpdatePrompt.tsx`, чтобы отложить
 * подмену сборки, пока человек занят вводом (с 10.09.2026 подмена молчаливая,
 * полноэкранного экрана обновления больше нет).
 *
 * Расширено 09.09.2026 (R2-код-ревью, дефект «мешает»): раньше проверялся
 * только фокус в input/textarea/contenteditable с непустым значением —
 * перезагрузка среди дня всё равно ловила человека посреди заполнения формы в
 * модалке (фокус мог быть на select/чекбоксе без "value" в привычном смысле),
 * с открытой шторкой поверх экрана, или с незавершённой загрузкой файла. Любой
 * из четырёх сигналов ниже откладывает подмену — максимум на MAX_DEFER_MS
 * (5 минут, см. store/appUpdate.ts), дальше обновляем в любом случае: нельзя,
 * чтобы забытая открытая форма держала вкладку на старой сборке вечно. Переход
 * между разделами снимает отсрочку раньше: экран и так перерисовывается.
 *
 * ПОЛЕ СЧИТАЕТСЯ ЗАНЯТЫМ, ТОЛЬКО ЕСЛИ В НЕГО ДЕЙСТВИТЕЛЬНО ПЕЧАТАЛИ
 * (10.09.2026, поймано замером на стенде). «Фокус в поле с непустым значением»
 * оказалось не тем же самым, что «человек печатает»: экран входа сам ставит
 * фокус в поле телефона и сам подставляет туда «+992» — то есть НИКОГДА не
 * тронутая вкладка на /login считалась занятой всегда и не обновлялась до
 * потолка в пять минут. Тот же случай — любое поле с подставленным значением,
 * на которое фокус встал при открытии экрана. Поэтому поля, которых человек не
 * касался, в счёт не идут: занятость помечает событие ввода
 * (`startTypingActivityTracker`), а не разметка. Модалка, `data-dirty` и
 * незавершённая загрузка файла работают как раньше — каждое из них само по
 * себе уже след действия человека.
 *
 * Вынесено в отдельный модуль из UpdatePrompt.tsx, чтобы юнит-тест не тянул
 * компонент целиком (тот импортирует `virtual:pwa-register/react` — виртуальный
 * модуль vite-plugin-pwa, недоступный в vitest вне сборки).
 */

/** Поля, в которые человек уже вводил. WeakSet: снятый со страницы элемент
 *  уходит из памяти вместе с меткой, чистить руками нечего. */
const touched = new WeakSet<object>();

/** Пометить поле как «в него печатали». Экспортируется для трекера и теста. */
export function noteFieldTouched(el: object | null | undefined): void {
  if (el) touched.add(el);
}

/**
 * Слушает ввод на всём документе в фазе перехвата — так события доходят и от
 * полей внутри модалок, которые останавливают всплытие. Возвращает отписку.
 */
export function startTypingActivityTracker(): () => void {
  const onInput = (event: Event) => noteFieldTouched(event.target as object | null);
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onInput, true);
  return () => {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("keydown", onInput, true);
  };
}

export function isUserActivelyTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (el && touched.has(el)) {
    const tag = el.tagName;
    if (tag === "TEXTAREA" && ((el as HTMLTextAreaElement).value ?? "").length > 0) return true;
    if (tag === "INPUT" && ((el as HTMLInputElement).value ?? "").length > 0) return true;
    if (tag === "SELECT" && ((el as HTMLSelectElement).value ?? "").length > 0) return true;
    if (el.isContentEditable && (el.textContent ?? "").trim().length > 0) return true;
  }
  // Открытая модалка/шторка — обновление посреди диалога прервало бы то, что в
  // нём заполняется, даже если конкретное поле сейчас пустое (например, между
  // шагами мастера).
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  // Несохранённая форма — компонент сам помечает себя, когда в нём есть
  // введённые, но не отправленные изменения (data-dirty на <form>, или
  // data-unsaved на отдельных полях, если формы как таковой нет).
  if (document.querySelector("form[data-dirty], [data-unsaved]")) return true;
  // Незавершённая загрузка файла — выбранный, но ещё не отправленный файл в
  // input[type=file] (форма могла ещё не выставить data-dirty на себя).
  const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
  for (const input of fileInputs) {
    if (input.files && input.files.length > 0) return true;
  }
  return false;
}

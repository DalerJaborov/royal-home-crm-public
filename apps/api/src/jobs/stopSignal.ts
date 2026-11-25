/**
 * Сигнал «процесс выходит» для долгих обработчиков очереди (25.11.2026): сжатие видео идёт
 * минуты, а выкат перезапускает worker с запасом 85 секунд. Обработчик по сигналу обрывает
 * ffmpeg и возвращает задание в очередь — новый процесс подхватит его через секунды, а не
 * через пятнадцать минут «зависшего RUNNING». Отдельный модуль, чтобы обработчики не
 * импортировали runner.ts (runner → handlers → обработчик → runner было бы циклом).
 */
const controller = new AbortController();

export const backgroundJobsStopSignal: AbortSignal = controller.signal;

export function signalBackgroundJobsStop(): void {
  controller.abort();
}

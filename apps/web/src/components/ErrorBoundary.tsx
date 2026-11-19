import React from "react";
import { isChunkLoadError } from "../lib/chunkLoadError";

/**
 * Последний рубеж на клиенте. Без него любая ошибка рендера обваливала всё
 * приложение в белый экран: пользователь видит пустую страницу и не понимает,
 * что делать, а сама ошибка не попадает в журнал CRM (в отличие от ошибок в
 * обработчиках, которые ловит initErrorReporter).
 *
 * Показываем понятный экран с кнопкой перезагрузки и репортим ошибку в журнал
 * тем же способом, что и глобальный репортер — через window.onerror-совместимое
 * событие, чтобы не тянуть сюда лишних зависимостей.
 */
interface State {
  error: Error | null;
  resetKey?: string;
}

interface Props {
  children: React.ReactNode;
  resetKey?: string;
  /**
   * Своя заглушка вместо полноэкранной «Что-то пошло не так» — для границы
   * БЛОКА (components/BlockBoundary.tsx): упал один блок, остальные живут.
   * `retry` снимает ошибку и рисует блок заново; `error` — пойманная ошибка
   * (по ней граница блока отличает «кусок сборки не загрузился»).
   */
  fallback?: (retry: () => void, error: Error) => React.ReactNode;
  /** Имя блока — уходит в журнал ошибок префиксом, чтобы было видно, что упало. */
  name?: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  /** Reset a failed route without remounting a healthy Suspense boundary on every navigation. */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", this.props.name ?? "", error, info.componentStack);
    // Пробрасываем в глобальный обработчик, который уже умеет писать в журнал CRM.
    const message = this.props.name ? `[блок ${this.props.name}] ${error.message}` : error.message;
    window.dispatchEvent(new ErrorEvent("error", { error, message }));
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry, this.state.error);
    // Кусок сборки не загрузился — почти всегда это выкат при открытой вкладке, а
    // не поломка: lazyWithReload уже дважды пробовал перезагрузить страницу сам.
    // Человеку честно говорим, что делать, а не «что-то пошло не так» (аудит
    // F2-6, 17.11.2026).
    const stale = isChunkLoadError(this.state.error);
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-center px-6">
        <h1 className="text-[18px] font-bold tracking-tight mb-1">{stale ? "Вышла новая версия приложения" : "Что-то пошло не так"}</h1>
        <p className="text-[15px] text-gray-500 mb-5 max-w-[420px]">
          {stale
            ? "Часть приложения не загрузилась: страница открыта со старой версией. Обновите страницу, если не поможет — проверьте интернет."
            : "Страница не смогла отрисоваться. Ошибка записана в журнал, попробуйте обновить страницу."}
        </p>
        <button type="button"
          onClick={() => window.location.reload()}
          className="bg-blue text-on-accent text-[15px] font-semibold rounded-lg px-4 py-2 shadow-sm hover:bg-blue-hover"
        >
          Обновить страницу
        </button>
      </div>
    );
  }
}

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
// Golos Text УБРАН (10.09.2026, «как родное приложение»). Он подключался пятью
// файлами @fontsource и применялся правилом `html[data-mobile-ux] body` в
// index.css, у которого — в отличие от соседних мобильных правил — не было
// исключения для тем royal-home-2026-*. В итоге на телефоне ОБОЛОЧКА (верхняя
// панель, нижняя навигация, подсказки) рисовалась Golos Text, а содержимое
// внутри `.rh2` — эталонным Manrope: две гарнитуры на одном экране вразрез с
// договором дизайна, и 26 КБ лишних шрифтов в критическом пути первого экрана
// (замер: 3 файла Golos из 10 запрошенных). Теперь вся оболочка наследует
// --font-sans, то есть тот же Manrope, что и содержимое. Сам пакет остаётся в
// package.json — выкинуть его оттуда без `npm install` нельзя, это отдельный шаг.
import "./index.css";
import { startOfflineQueue } from "./lib/offlineQueue";
import { startUploadQueue } from "./lib/uploadQueue";
import { resumeDraftUploadsOnStart } from "./lib/draftUploadsResume";
import { api } from "./lib/api";
import { initErrorReporter } from "./lib/errorReporter";
import { initMobileUxFlag } from "./hooks/useMobileUx";
import { initTabHiddenFlag } from "./lib/tabHidden";
import { queryClient } from "./lib/queryClient";
import { restoreQueryCache } from "./lib/queryPersist";
import { startPostLoginPrefetch } from "./lib/prefetchAfterIdle";
import { useAuthStore } from "./store/auth";

// Записи, сделанные без сети, уходят на сервер при появлении соединения.
// Отправщик и «кто вошёл» передаются здесь, а не импортируются очередью:
// единственное место, где встречаются api/auth и очередь, — эти строки, и
// цикла импортов не возникает.
startOfflineQueue(
  api,
  () => useAuthStore.getState().agent?.id ?? null,
  // Вход в систему — повод досылать сразу, не дожидаясь сердцебиения очереди.
  (flush) =>
    useAuthStore.subscribe((state, prev) => {
      if (state.hasSession && !prev.hasSession) flush();
    })
);
// Фотографии и видео, не ушедшие из-за обрыва связи или закрытой вкладки, лежат
// в хранилище устройства и досылаются сами. Здесь же возвращаются в очередь
// задания, прерванные посреди отправки (см. lib/uploadQueue.ts).
startUploadQueue();
// То же для файлов мастера «Новый объект»: недогруженное лежит в IndexedDB и
// продолжает отдачу при входе агента, не дожидаясь, пока он снова откроет мастер.
resumeDraftUploadsOnStart();
// Ошибки браузера автоматически репортятся в журнал CRM (см. Настройки → Здоровье системы).
initErrorReporter();
// Признак «телефон или планшет» на <html> — по нему CSS превращает окна в шторки
// снизу (см. hooks/useMobileUx.ts и правила [role="dialog"] в index.css). Ставится
// до первой отрисовки: иначе окно, открытое сразу после запуска, успело бы мигнуть
// в настольном виде.
initMobileUxFlag();
// Признак «вкладка свёрнута/неактивна» на <html> — гасит бесконечные CSS-анимации
// проекта одним общим правилом (см. lib/tabHidden.ts и правило в index.css сразу
// после @tailwind). TASKS.md ~403/~740.
initTabHiddenFlag();
// Куски главной по роли и чатов — на простое браузера после входа, не по клику
// (lib/prefetchAfterIdle.ts, perf/web-instant-11-09).
startPostLoginPrefetch();

// Кэш React Query (queryPersist.ts) восстанавливается ДО первого рендера — экран
// открывается сразу с последними данными, а свежие подъезжают следом (задача
// perf/web-instant-11-09). restoreQueryCache сама решает, есть ли что восстанавливать
// (нет пользователя/снимка/устарел — просто резолвится), поэтому первый рендер не
// задерживается дольше чтения IndexedDB.
void restoreQueryCache().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
});

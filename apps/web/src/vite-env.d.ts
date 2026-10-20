/// <reference types="vite/client" />
/// Виртуальный модуль vite-plugin-pwa: через него компонент UpdatePrompt узнаёт,
/// что собрана новая версия приложения (см. components/UpdatePrompt.tsx).
/// <reference types="vite-plugin-pwa/react" />

/** Версия текущей сборки (GIT_SHA или момент сборки) — см. vite.config.ts и
 *  lib/appUpdate.ts. Подставляется `define` на этапе сборки, в dev — таймстамп. */
declare const __APP_VERSION__: string;

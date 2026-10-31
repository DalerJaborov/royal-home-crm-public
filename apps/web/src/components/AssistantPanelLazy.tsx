import { lazy, Suspense } from "react";

/**
 * ПАНЕЛЬ ИИ-АССИСТЕНТА, ЗАГРУЖАЕМАЯ ПО НАЖАТИЮ.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Панель открывают из нескольких мест оболочки: удержание
 * «+» на телефоне (BottomNav), кнопка в шапке на компьютере и сочетание клавиш
 * (AssistantHost). Все они живут во входном куске сборки, а он
 * скачивается и разбирается до первой отрисовки. Ленивый импорт в одном месте
 * ничего не даёт: сборщик прямо предупреждает «dynamic import will not move
 * module into another chunk», пока хотя бы один статический импорт остался.
 * Поэтому обёртка одна на все места — иначе следующая правка снова подключит
 * панель напрямую и тихо вернёт её вместе с распознаванием речи и «лицом» ИИ во
 * входной кусок.
 *
 * ПРЕДЗАГРУЗКА ПО НАМЕРЕНИЮ (31.10.2026). Без неё первое открытие ждёт скачивания
 * куска, а заглушка — пустой кадр. `preloadAssistantPanel()` вешается на наведение,
 * фокус и pointerdown кнопок входа: пока палец или курсор идёт к клику, кусок уже
 * едет. Обещание кэшируется — повторный вызов ничего не стоит.
 *
 * ЗАГЛУШКА `null`: панель — поверхность поверх экрана по намеренному нажатию,
 * мигать пустотой хуже, чем открыться на кадр позже.
 *
 * Условие вокруг вызова обязательно (`{open && <AssistantPanelLazy …/>}`) —
 * без него файл скачается сразу, и смысл теряется.
 */
const loadPanel = () => import("./AssistantPanel").then((m) => ({ default: m.AssistantPanel }));

let preloaded: ReturnType<typeof loadPanel> | null = null;

/** Начать скачивание куска панели заранее. Безопасно вызывать сколько угодно раз. */
export function preloadAssistantPanel(): void {
  if (preloaded) return;
  preloaded = loadPanel();
  // Сбой сети не должен оставлять «вечный» отказ: следующая попытка скачает заново.
  preloaded.catch(() => {
    preloaded = null;
  });
}

const AssistantPanel = lazy(() => preloaded ?? (preloaded = loadPanel()));

export function AssistantPanelLazy(props: {
  onClose: () => void;
  autoStartVoice?: boolean;
  initialPrompt?: string;
}) {
  return (
    <Suspense fallback={null}>
      <AssistantPanel {...props} />
    </Suspense>
  );
}

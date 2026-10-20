/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { CacheExpiration, ExpirationPlugin } from "workbox-expiration";
import { API_CACHE_NAME, isCacheableApiResponse, isOfflineCacheableApiRequest, responseFacts } from "./lib/swApiCache";

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// Любой переход внутри приложения отдаём из прекешированной оболочки. Без этого
// офлайн (и просто обрыв связи) на глубоком адресе показывал страницу ошибки
// браузера вместо CRM — при том что весь интерфейс уже лежал в кэше.
// API и загруженные файлы исключены: их обрабатывают свои правила ниже.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/uploads\//],
  })
);

/**
 * ОТВЕТЫ API — ТОЛЬКО ОФЛАЙН-НУЖНЫЕ РАЗДЕЛЫ (17.09.2026).
 *
 * Раньше сюда ложился любой GET к /api/v1/* (кроме двух исключений), а
 * NetworkFirst отдаёт кэш не только без сети, но и когда сервер молчит дольше
 * четырёх секунд — например, в секунды перезапуска api-контейнера при выкате.
 * Ключ записи — только адрес, без сотрудника и версии сборки. Так после двух
 * выкатов подряд «Настройки → Каналы связи» показывали вчерашние (и чужие,
 * усечённые) настройки при исправном сервере. Какие разделы кэшируются и
 * почему именно они — в lib/swApiCache.ts; короткая заметка для людей —
 * docs/pwa-cache-17-09.md.
 *
 * POST/PATCH не кэшируются никогда: их безопасно выполнять только при реальном
 * сетевом ответе, чтобы не потерять данные молча.
 */
const API_CACHE_LIMITS = { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 };

registerRoute(
  ({ url, request }) => isOfflineCacheableApiRequest(url.pathname, request.method),
  new NetworkFirst({
    cacheName: API_CACHE_NAME,
    // 06.10.2026: было 4 с. При ответе API дольше четырёх секунд (тяжёлый
    // дашборд, список клиентов на медленном телефоне) воркер отдавал кэш
    // суточной давности, и человек видел «не обновилось» при живом сервере.
    // 10 с: без сети кэш по-прежнему отдаётся сразу (обрыв, а не таймаут).
    // /mission-control и прочее живое в список кэшируемых не входит вовсе
    // (lib/swApiCache.ts), а /dashboard и /clients там нужны ради офлайна.
    networkTimeoutSeconds: 10,
    plugins: [
      new ExpirationPlugin(API_CACHE_LIMITS),
      {
        // Только JSON 200 без no-store: под разрешёнными разделами есть и архивы
        // фото, и видео, и выгрузки — им в кэше не место (см. isCacheableApiResponse).
        cacheWillUpdate: async ({ response }) => (isCacheableApiResponse(responseFacts(response)) ? response : null),
      },
    ],
  })
);

registerRoute(
  ({ url }) => url.pathname.startsWith("/uploads/"),
  new CacheFirst({
    cacheName: "uploads-cache",
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  })
);

/**
 * КНОПКА «ОБНОВИТЬ» НИЧЕГО НЕ ДЕЛАЛА (найдено 15.08.2026 по жалобе владельца:
 * «написано, что вышло обновление, нажал — ничего не произошло»).
 *
 * Здесь стояло `install → self.skipWaiting()`. Новая версия активировалась сама,
 * не дожидаясь разрешения, — то есть ровно то поведение, ради отказа от которого
 * в vite.config.ts выбран `registerType: "prompt"`.
 *
 * Из-за этого ломалась вся цепочка полосы «Вышла новая версия»:
 *   1. Полоса всё же показывалась — на краткий миг между «установлен» и
 *      «активирован» браузер успевал сообщить о ждущей версии.
 *   2. К нажатию ждать было уже нечего: `messageSkipWaiting()` из
 *      vite-plugin-pwa шлёт сообщение ИМЕННО ждущему воркеру, а его больше нет,
 *      и вызов молча превращался в пустой.
 *   3. Перезагрузку страницы плагин делает по событию «сменился управляющий
 *      воркер» — оно тоже прошло раньше, ещё до появления полосы.
 * Три звена, и каждое отработало «без ошибок»: ни отказа, ни записи в консоли.
 *
 * Стало: новая версия ЖДЁТ, пока человек не нажмёт «Обновить» (или не закроет
 * все вкладки CRM). Сообщение о разрешении приходит ниже, в обработчике
 * `message`, — без него кнопке по-прежнему нечем было бы разбудить воркера.
 *
 * skipWaiting при первой в жизни установке не нужен: управляющего воркера ещё
 * нет, и новый активируется сразу сам.
 */
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") self.skipWaiting();
});

/**
 * НОВАЯ ВЕРСИЯ ВОРКЕРА НАЧИНАЕТ С ПУСТОГО «api-cache» (17.09.2026).
 *
 * Прекеш оболочки workbox сам заменяет при смене версии, а runtime-кэш ответов
 * API переживал выкат нетронутым: записи до суток, снятые старой сборкой с
 * прежнего сервера. Новая версия экрана читала из них поля, которых там ещё не
 * было. Поэтому вместе с активацией новой версии кэш ответов удаляется целиком —
 * вместе с учётом сроков хранения ExpirationPlugin (иначе индекс в IndexedDB
 * останется ссылаться на несуществующие записи). Страница в этот же миг
 * перезагружается по controllerchange (lib/appUpdateReload.ts) и наполняет кэш
 * заново уже ответами нового сервера. «uploads-cache» не трогаем: файлы
 * хешированы адресом, выкат их не меняет, а весят они десятки мегабайт.
 *
 * `clients.claim()` — не украшение, а второе обязательное звено цепочки
 * обновления: плагин перезагружает страницу по смене управляющего воркера, а
 * без claim новый воркер взял бы вкладку под управление только при следующем
 * открытии. Чистка кэша идёт ДО claim, чтобы первая же загрузка новой оболочки
 * не успела прочитать старую запись.
 */
async function dropStaleApiCache(): Promise<void> {
  try {
    await caches.delete(API_CACHE_NAME);
    // Не `ExpirationPlugin.deleteCacheAndMetadata()`: он обходит только кэши,
    // которые ЭТОТ экземпляр уже трогал, а у свежеактивированного воркера их
    // ещё нет — вызов молча ничего не удалял бы. CacheExpiration по имени
    // вычищает индекс сроков хранения независимо от того, кто его писал.
    await new CacheExpiration(API_CACHE_NAME, API_CACHE_LIMITS).delete();
  } catch {
    // Кэша могло не быть (первая установка) или он уже удалён страницей при
    // жёстком сбросе — активация от этого не должна зависеть.
  }
}

self.addEventListener("activate", (event) => event.waitUntil(dropStaleApiCache().then(() => self.clients.claim())));

// Тип payload — общий с API (@royal-home/shared): его копия здесь однажды уже
// разошлась с серверной, а расхождение в таком поле не ломает сборку, а молча
// превращает кнопку в её отсутствие. Импорт только типа — в бандл ничего не идёт.
import type { PushPayload, PushActionResult } from "@royal-home/shared";
import { handleLoginCodePush, isLoginCodePush } from "./lib/swLoginCode";

/**
 * Число на иконке приложения, пока оно закрыто (Badging API).
 *
 * Считаем уведомления, висящие в шторке. Своего счётчика здесь нет и быть не
 * может: у service worker нет ни JWT, чтобы спросить сервер, ни памяти между
 * запусками — система убивает его сразу после обработки push. А шторку хранит
 * сама система, она переживает и перезапуск воркера, и перезагрузку телефона.
 *
 * Уведомления с одинаковым tag схлопываются в одно — значит, число совпадает с
 * тем, что человек видит в шторке, а не с количеством отправленных сигналов.
 * Это и нужно.
 *
 * Когда приложение открывают, значок пересчитывается по счётчикам разделов
 * (hooks/useAppBadge.ts) — расхождение живёт ровно до первого открытия.
 */
async function syncBadgeToTray(): Promise<void> {
  // На Android этого API нет вовсе: там точку на иконке рисует сама система,
  // пока уведомление в шторке. Лишний вызов getNotifications там не нужен.
  if (typeof navigator.setAppBadge !== "function") return;
  try {
    const pending = await self.registration.getNotifications();
    if (pending.length > 0) await navigator.setAppBadge(pending.length);
    else await navigator.clearAppBadge();
  } catch {
    // Значок — украшение, а не доставка. Отказ (нет разрешения, приложение
    // открыто вкладкой, а не установлено) не должен ронять обработку push.
  }
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    const raw: unknown = event.data.json();
    // Код входа — служебный пуш: показываем сразу и отчитываемся серверу о
    // доставке, мимо остальных правил (закрытие по tag, значок в шторке).
    if (isLoginCodePush(raw)) {
      event.waitUntil(handleLoginCodePush(raw, self.registration));
      return;
    }
    payload = raw as PushPayload;
  } catch {
    return;
  }

  // Служебный сигнал «закрой уведомление» (лид ушёл от агента, пока висел
  // непринятым — владелец 19.08.2026) — не показываем новое, гасим то, что
  // уже висит с этим tag. Без tag закрывать нечего, не пытаемся угадать.
  if (payload.close) {
    if (!payload.tag) return;
    const tag = payload.tag;
    event.waitUntil(
      self.registration
        .getNotifications({ tag })
        .then((existing) => existing.forEach((n) => n.close()))
        .then(syncBadgeToTray)
    );
    return;
  }

  event.waitUntil(
    self.registration
      .showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        // Аватар клиента: настоящее фото из мессенджера (lib/clientAvatar.ts) либо, если
        // фото нет, нарисованный сервером кружок с тоном по имени и значком «покупатель/
        // продавец» (lib/clientAvatarFallback.ts) — оба вида короткий путь /uploads/...,
        // браузер скачивает картинку сам, в теле push-сообщения байтов нет (до
        // 25.08.2026 запасной вариант ехал base64 прямо в payload и раздувал его сверх
        // лимита Apple/FCM ~4096 байт). С 19.08.2026 аватар есть практически всегда —
        // раньше все клиенты выглядели в шторке одной иконкой приложения, и узнать
        // написавшего можно было только открыв карточку.
        //
        // Запасной путь — icon-192.png, А НЕ icon.svg: Chromium декодирует картинку
        // уведомления обычным декодером изображений, в котором SVG намеренно выключен,
        // так что прежний /icon.svg на Android не рисовался вовсе — уведомление молча
        // оставалось без значка. По той же причине сервер и присылает PNG, а не SVG.
        icon: payload.avatarUrl ?? "/icon-192.png",
        // badge (монохромный значок в трее) остаётся иконкой приложения намеренно: это
        // другая роль, фото клиента ей не подходит. Тоже PNG — ограничение то же.
        badge: "/icon-192.png",
        // Safari (iPhone, включая установленную PWA) поле actions игнорирует —
        // уведомление там остаётся обычным, и нажатие открывает карточку. Отдельной
        // ветки под iPhone это не требует: ниже маркера действия просто не будет.
        actions: payload.actions,
        data: { url: payload.url ?? "/", actionToken: payload.actionToken },
      })
      // Строго ПОСЛЕ показа: считать шторку до того, как в ней появилось новое
      // уведомление, значит всегда отставать на единицу.
      .then(syncBadgeToTray)
  );
});

// Уведомления смахнули, не открывая CRM, — значок обязан погаснуть вместе с
// ними. Без этого число висело бы на иконке до следующего запуска приложения.
self.addEventListener("notificationclose", (event) => {
  event.waitUntil(syncBadgeToTray());
});

/** Открыть CRM: фокусируем уже открытую вкладку вместо того, чтобы плодить новые. */
async function openCrm(targetUrl: string): Promise<void> {
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientsList) {
    if ("focus" in client) {
      client.postMessage({ type: "PUSH_NAVIGATE", url: targetUrl });
      await client.focus();
      return;
    }
  }
  await self.clients.openWindow(targetUrl);
}

/**
 * Кнопка «Принять»/«Отклонить», нажатая прямо в шторке.
 *
 * Здесь нет ни JWT, ни доступа к хранилищу вкладки — право на одно действие
 * приезжает в самом уведомлении одноразовым маркером (см. lib/pushLeadActions.ts
 * на сервере). Итог показываем отдельным уведомлением: агент нажал кнопку, не
 * открывая CRM, и обязан узнать, что из этого вышло. Текст итога приходит с
 * сервера — сочинять его здесь значило бы завести вторую копию формулировок.
 */
async function runLeadAction(action: string, token: string, fallbackUrl: string): Promise<void> {
  let result: PushActionResult;
  try {
    const response = await fetch("/api/v1/push/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action }),
    });
    result = (await response.json()) as PushActionResult;
  } catch {
    // Связи нет. Маркер не сожжён (запрос не дошёл), поэтому честнее позвать в
    // CRM, чем молча проглотить нажатие: агент решил, что лид принят.
    result = { ok: false, message: "Нет связи — откройте карточку в CRM", url: fallbackUrl };
  }

  await self.registration.showNotification(result.ok ? "✅ Готово" : "⚠️ Не выполнено", {
    body: result.message,
    // PNG, а не SVG: см. пояснение у уведомления выше — SVG декодер уведомлений
    // Chromium не читает, значок просто не появлялся бы.
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: `lead-action-${token.slice(-8)}`,
    data: { url: result.url ?? fallbackUrl },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string; actionToken?: string } | undefined;
  const targetUrl = data?.url ?? "/";

  if (event.action && data?.actionToken) {
    // Пересчёт после показа итога: одно уведомление ушло, другое пришло — на
    // иконке должно остаться верное число, CRM при этом никто не открывал.
    event.waitUntil(runLeadAction(event.action, data.actionToken, targetUrl).then(syncBadgeToTray));
    return;
  }

  event.waitUntil(openCrm(targetUrl).then(syncBadgeToTray));
});

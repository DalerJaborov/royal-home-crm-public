/**
 * Фоновая подготовка новой сборки — чтобы сама подмена заняла доли секунды.
 *
 * ОТКУДА ВЗЯЛОСЬ. Прогрев жил внутри полноэкранного `UpdateOverlay.tsx`: экран
 * скачивал свежий index.html, доставал из него ссылки на хешированные
 * /assets/*.js|css и тянул их, рисуя честный процент. Владелец 10.09.2026
 * потребовал убрать сам экран («большое и раздражает»), но прогрев терять
 * нельзя — без него перезагрузка ждёт сеть заново, и «мгновенно» не выходит.
 * Поэтому прогрев переехал сюда и запускается СРАЗУ, как только стало известно
 * о новой версии, пока человек продолжает работать. К моменту подмены файлы
 * уже лежат в кэше браузера.
 *
 * ДВА КАНАЛА, оба обязательны:
 *
 *  1. `registration.update()` — просит service worker начать установку новой
 *     сборки. Это главный путь: когда воркер встанет в waiting, обновление
 *     применится штатно (SKIP_WAITING + controllerchange), без перезагрузки в
 *     старый прекеш. Прекеш качает сам воркер — это самая тяжёлая часть.
 *  2. Ручной прогрев файлов из свежего index.html — страховка на случай, когда
 *     воркера нет вовсе (не зарегистрировался, приватный режим, iOS после
 *     очистки) и подмена пойдёт обычной перезагрузкой.
 *
 * ИДЕМПОТЕНТНО: повторный вызов возвращает ту же обещанную работу, а не
 * запускает второй прогрев. Отказы гасятся молча — прогрев ускоряет обновление,
 * но не отвечает за него: не прогрелось, значит подмена просто сходит в сеть.
 */
const HARD_TIMEOUT_MS = 20_000;
const ASSET_URL_RE = /(?:src|href)="(\/(?:assets\/[^"]+|manifest\.webmanifest))"/g;

let prepared: Promise<void> | null = null;
let ready = false;

/** Ссылки на файлы сборки из разметки index.html — экспортируется для теста. */
export function extractAssetUrls(html: string): string[] {
  return Array.from(new Set(Array.from(html.matchAll(ASSET_URL_RE), (m) => m[1])));
}

/** Прогрев завершился — подмена не будет ждать сеть. */
export function isAppUpdateReady(): boolean {
  return ready;
}

/** Только для тестов: забыть уже начатую подготовку. */
export function resetAppUpdatePrefetch(): void {
  prepared = null;
  ready = false;
}

async function kickServiceWorkerUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  } catch {
    // сеть/CORS/воркера нет — второй канал (прогрев файлов) всё равно отработает
  }
}

async function warmBuildAssets(): Promise<void> {
  const res = await fetch(`/index.html?t=${Date.now()}`, { cache: "no-store" });
  const html = await res.text();
  const urls = extractAssetUrls(html);
  await Promise.all(
    urls.map((url) =>
      // force-cache: файл хеширован, менять его содержимое некому — если он уже
      // в кэше браузера, второй раз не качаем.
      fetch(url, { cache: "force-cache" }).catch(() => {
        // один файл не прогрелся — не критично, перезагрузка подтянет его сама
      })
    )
  );
}

async function run(): Promise<void> {
  try {
    await Promise.all([kickServiceWorkerUpdate(), warmBuildAssets()]);
  } catch {
    // index.html не отдался — подмена просто пойдёт по сети, как раньше
  } finally {
    ready = true;
  }
}

/**
 * Начать (или дождаться уже начатую) подготовку. Никогда не отклоняется и
 * никогда не висит дольше HARD_TIMEOUT_MS — вызывающий код может её ждать
 * перед подменой, не рискуя застрять на мёртвой сети.
 */
export function prepareAppUpdate(): Promise<void> {
  if (!prepared) {
    prepared = Promise.race([
      run(),
      new Promise<void>((resolve) => setTimeout(resolve, HARD_TIMEOUT_MS)),
    ]);
  }
  return prepared;
}

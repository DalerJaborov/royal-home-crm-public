/**
 * ЯДРО СВЕРОЧНОГО СКРИПТА `design-parity.mjs` (06.10.2026).
 *
 * Здесь всё, что не зависит от порядка прогона: вход через API, посев
 * localStorage, замер геометрии на странице (`probe`), честность кадра
 * (`witness`), прокрутка нужного контейнера, сравнение PNG, разбор маршрутов
 * из `App.tsx`. Главный файл только склеивает это в прогон и пишет отчёт.
 *
 * Перенесено из ветки `wip/tree-snapshot-06-10`:
 *   · `parity1440/shots.mjs` — цепочка фикстур `answered/makeBody/withRequired`,
 *     свидетель кадра `witness`, посев `royal-home-auth`/`royal-home-ui`,
 *     `serviceWorkers: "block"` (service worker перехватил бы запросы раньше
 *     `page.route`, наблюдение 0141);
 *   · `mobile-parity-shots.mjs` — замер `probe` (тап-цели, мелкий шрифт,
 *     горизонтальный вылет с исключением боковых лент, контраст), заглушка
 *     `Notification`, флаг `rh:greeting:skip`.
 * Отличие от оригиналов: кадр снимается ВЬЮПОРТОМ, а не «по высоте
 * содержимого», поэтому `contentHeight` не нужна, а замер идёт по шагам
 * прокрутки (элемент вне вьюпорта не имеет «настоящей» зоны нажатия, её не
 * проверить `elementFromPoint`).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ───────────────────────────── роли и вход ───────────────────────────── */

/** Телефоны сида `apps/api/prisma/seed.ts` (пароль у всех `password123`). */
export const SEED_PASSWORD = "password123";
export const ROLE_PHONES = {
  director: "+992900000000",
  admin: "+992900000001",
  agent: "+992900000002",
  agent2: "+992900000003",
  manager: "+992900000004",
  marketing: "+992900000005",
  editor: "+992900000006",
  security: "+992900000007",
  shareholder: "+992900000009",
  head_of_sales: "+992900000010",
};

export function phoneFor(role) {
  if (/^\+?\d{9,}$/.test(role)) return role.startsWith("+") ? role : `+${role}`;
  const p = ROLE_PHONES[role.toLowerCase()];
  if (!p) throw new Error(`неизвестная роль «${role}»; известные: ${Object.keys(ROLE_PHONES).join(", ")} или телефон`);
  return p;
}

/**
 * Вход через API, а не через форму: в контекст браузера ложится refresh-cookie
 * (ею приложение при старте берёт access-токен), а в localStorage посевом идёт
 * та же личность, что вернул сервер. `ctx.request` делит cookie с контекстом.
 */
export async function loginApi(ctx, base, role) {
  const res = await ctx.request.post(`${base}/api/v1/auth/login`, {
    data: { phone: phoneFor(role), password: SEED_PASSWORD },
    timeout: 20000,
  });
  if (!res.ok()) throw new Error(`вход ${role}: HTTP ${res.status()} ${(await res.text()).slice(0, 160)}`);
  const json = await res.json();
  if (!json.accessToken || !json.agent) {
    throw new Error(`вход ${role}: сервер не выдал сессию (${Object.keys(json).join(", ")}); включён TOTP или СМС-код?`);
  }
  return { agent: json.agent, accessToken: json.accessToken };
}

const THEMES = { light: "royal-home-2026-light", night: "royal-home-2026-night" };

/**
 * Посев localStorage ДО первого скрипта страницы. Тему атрибутом руками не
 * ставим (init-скрипт исполняется раньше `documentElement`): приложение читает
 * её из `royal-home-ui`, а `witness` проверяет, что она применилась.
 */
export async function seedStorage(ctx, { agent, theme = "light" }) {
  const themeId = THEMES[theme] ?? THEMES.light;
  await ctx.addInitScript(
    ([auth, ui]) => {
      localStorage.setItem("royal-home-auth", auth);
      localStorage.setItem("royal-home-ui", ui);
      localStorage.setItem("rh:greeting:skip", "1");
      // `permissions:["notifications"]` не меняет `Notification.permission` в
      // автоматическом Chromium: без заглушки сверху встаёт карточка
      // «Уведомления заблокированы», которой на телефоне владельца нет.
      try {
        Object.defineProperty(Notification, "permission", { get: () => "granted" });
      } catch {
        /* другой браузер — карточка просто останется на кадре */
      }
    },
    [
      JSON.stringify({ state: { agent, hasSession: true }, version: 1 }),
      JSON.stringify({
        state: {
          theme: themeId,
          look: "classic",
          aurora: false,
          glass: true,
          dashboardHidden: [],
          autoLogoutMinutes: 30,
          dismissedHints: [],
          sidebarCollapsed: false,
          aiSoundsEnabled: false,
          updatedAt: Date.now(),
          syncedAt: Date.now(),
        },
        version: 1,
      }),
    ]
  );
  return themeId;
}

/* ─────────────── подмена API фикстурами (режим --mock) ─────────────── */

/** Пустой объект от справочника означает «не знаю» — идём дальше по цепочке;
 *  `null` и непустой объект — это ответ. */
export function answered(v) {
  if (v === undefined) return false;
  if (v === null) return true;
  if (Array.isArray(v)) return true;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * Цепочка справочников: `modules` это список функций `(url) => тело|undefined`.
 * Первый давший ответ побеждает; неизвестный путь записывается в `unmocked` и
 * отдаёт `{}` (экран должен быть виден на кадре пустым, а не валить прогон).
 */
export function makeBody(modules, unmocked = new Set()) {
  return (url) => {
    for (const fn of modules) {
      let v;
      try {
        v = fn(url);
      } catch {
        continue;
      }
      if (answered(v)) return v;
    }
    unmocked.add(url.replace(/^.*\/api\/v1/, "").split("?")[0]);
    return {};
  };
}

/**
 * Обязательные поля, которых нет ни в одном чужом справочнике. Настоящий сервер
 * всегда отдаёт название агентства; без него вкладка «Агентство» падала на
 * `.trim()`. Дополняем ответ, а не подменяем.
 */
const REQUIRED = {
  "/settings": { companyName: "Royal Home", companySlogan: "Агентство недвижимости", companyLogoUrl: null },
};

export function withRequired(body) {
  return (url) => {
    const u = url.replace(/^.*\/api\/v1/, "").split("?")[0];
    const v = body(url);
    const extra = REQUIRED[u];
    if (!extra || !v || typeof v !== "object" || Array.isArray(v)) return v;
    const merged = { ...v };
    for (const [k, value] of Object.entries(extra)) if (merged[k] === undefined) merged[k] = value;
    return merged;
  };
}

/* ───────────────────────────── маршруты ───────────────────────────── */

/**
 * Маршруты под `AppLayout` из `App.tsx`. Пропускаются: `*`, `/dev/*`, редиректы
 * (`<Navigate`). Параметрические возвращаются как есть (`/clients/:id`), id
 * подставляет главный файл. Возвращает `{ routes, skipped }`.
 */
export function discoverRoutes(appTsxPath) {
  const src = readFileSync(appTsxPath, "utf8");
  const at = src.indexOf("<AppLayout />");
  if (at < 0) throw new Error(`в ${appTsxPath} нет <AppLayout /> — формат App.tsx изменился`);
  const tail = src.slice(at);
  const end = tail.indexOf("</Routes>");
  const block = end >= 0 ? tail.slice(0, end) : tail;
  const chunks = block.split(/<Route\b/).slice(1);
  const routes = [];
  const skipped = [];
  for (const chunk of chunks) {
    const isIndex = /^\s+index\b/.test(chunk);
    const m = /^\s*(?:[^>]*?\s)?path="([^"]+)"/.exec(chunk.slice(0, 400));
    if (!isIndex && !m) continue;
    const raw = isIndex ? "" : m[1];
    const route = "/" + raw.replace(/^\//, "");
    if (raw === "*") continue;
    if (/^\/dev\//.test(route)) {
      skipped.push({ route, reason: "служебный /dev/*" });
      continue;
    }
    // Тело маршрута — до следующего `<Route`, которое мы уже отрезали.
    if (/<Navigate\b/.test(chunk.slice(0, 600))) {
      skipped.push({ route, reason: "редирект на другой маршрут" });
      continue;
    }
    if (!routes.includes(route)) routes.push(route);
  }
  return { routes, skipped };
}

/** Откуда брать id для параметра: `[путь API списка]`. */
const PARAM_LISTS = {
  properties: "/properties?pageSize=1",
  clients: "/clients?pageSize=1",
  team: "/team",
  propertyId: "/properties?pageSize=1",
};

function firstId(json) {
  const list = Array.isArray(json) ? json : (json?.items ?? json?.data ?? json?.rows ?? []);
  const first = Array.isArray(list) ? list[0] : null;
  return first?.id ?? first?.agentId ?? null;
}

/**
 * Подставляет id первой записи в параметрический маршрут. `fetchJson(apiPath)`
 * отдаёт тело или бросает. Возвращает `{ route }` либо `{ skip: причина }`.
 */
export async function resolveParams(route, fetchJson) {
  const params = [...route.matchAll(/:(\w+)/g)].map((m) => m[1]);
  if (!params.length) return { route };
  if (params.length > 1) return { skip: "несколько параметров" };
  const param = params[0];
  const firstSeg = route.split("/").filter(Boolean)[0];
  const source = PARAM_LISTS[param === "id" ? firstSeg : param];
  if (!source) return { skip: `нет источника для :${param} (проще открыть вручную)` };
  try {
    const id = firstId(await fetchJson(source));
    if (!id) return { skip: `список ${source.split("?")[0]} пуст — нет записи для :${param}` };
    return { route: route.replace(`:${param}`, encodeURIComponent(String(id))) };
  } catch (e) {
    return { skip: `не удалось получить id (${source.split("?")[0]}): ${String(e.message ?? e).slice(0, 80)}` };
  }
}

export function slugOf(route) {
  const s = route
    .replace(/^\//, "")
    .replace(/[\\/:?&=]+/g, "_")
    .replace(/[^\p{L}\p{N}_.-]+/gu, "-");
  return s || "root";
}

/* ───────────────────── замер на странице (page.evaluate) ───────────────────── */

/**
 * Ищет главный прокручиваемый контейнер и двигает его. На ПК это внутренний
 * `div` `AppLayout` (`md:overflow-y-auto`), на телефоне — сама страница.
 * `arg`: `{ to: "top" | "bottom" | number }` или `{ by: dy }`.
 * Возвращает `{ top, max, client, kind }`.
 */
export function scrollMain(arg) {
  const vh = window.innerHeight;
  let best = null;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    if (el.clientHeight < vh * 0.5) continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  const doc = document.scrollingElement || document.documentElement;
  // Если прокручивается страница, а не контейнер, берём страницу.
  const useDoc = !best || doc.scrollHeight - doc.clientHeight > best.scrollHeight - best.clientHeight;
  const target = useDoc ? doc : best;
  const max = Math.max(0, target.scrollHeight - target.clientHeight);
  let next = target.scrollTop;
  if (arg.by !== undefined) next += arg.by;
  else if (arg.to === "top") next = 0;
  else if (arg.to === "bottom") next = max;
  else if (typeof arg.to === "number") next = arg.to;
  target.scrollTop = Math.max(0, Math.min(max, next));
  return {
    top: Math.round(target.scrollTop),
    max: Math.round(max),
    client: Math.round(target.clientHeight),
    kind: useDoc ? "window" : "container",
  };
}

/**
 * Замер ОДНОГО положения прокрутки. Считает только то, что пересекает
 * вьюпорт: у элемента вне экрана нет «настоящей» зоны нажатия (его не достать
 * `elementFromPoint`). Склейка по шагам — на стороне вызывающего (ключ `key`).
 *
 * Тап-цель меряется по ЗОНЕ нажатия, а не по рамке: растянутая ссылка строки
 * списка и псевдоэлементы с отрицательным inset дают 44+ при рамке 23, поэтому
 * щупаем пальцем — бьём `elementFromPoint` от центра наружу.
 */
export function probe(opts) {
  const layerOnly = !!(opts && opts.sheet);
  const round = (n) => Math.round(n * 10) / 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.body;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const inView = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const hitBox = (el, r) => {
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hits = (x, y) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === el || el.contains(t) || t.contains(el));
    };
    if (!hits(cx, cy)) return { w: r.width, h: r.height };
    const grow = (dx, dy, limit) => {
      let d = 0;
      for (let i = 2; i <= limit; i += 2) {
        if (!hits(cx + dx * i, cy + dy * i)) break;
        d = i;
      }
      return d;
    };
    return {
      w: Math.max(r.width, grow(-1, 0, 24) + grow(1, 0, 24)),
      h: Math.max(r.height, grow(0, -1, 24) + grow(0, 1, 24)),
    };
  };
  /**
   * ЗОНА ПСЕВДОЭЛЕМЕНТА `::after` (F1, 06.10.2026). Растянутая ссылка строки
   * (`.rh-row-link::after{position:absolute;inset:0}`) и кнопки с запасом зоны
   * (`.rh-btn-sm::after{inset:-2px}`) нажимаются по псевдоэлементу, а не по
   * видимому боксу. Щупать пальцем `elementFromPoint` тут мало: щуп ограничен 24 px
   * в каждую сторону от центра ТЕКСТА ссылки, а он стоит не в центре строки, и
   * растянутая ссылка давала ложное «тап < 44» (9 штук на `/clients`). Поэтому
   * читаем размеры псевдоэлемента из computed style: `position:absolute`, размеры
   * в px уже посчитаны браузером (в том числе при `inset:0` и отрицательных
   * отступах), и берём больший из бокса элемента и бокса псевдоэлемента.
   */
  const afterZone = (el, r) => {
    const ps = getComputedStyle(el, "::after");
    if (!ps || ps.position !== "absolute" || ps.content === "none" || ps.content === "normal") return null;
    const pw = parseFloat(ps.width);
    const ph = parseFloat(ps.height);
    if (!Number.isFinite(pw) || !Number.isFinite(ph)) return null;
    // Псевдоэлемент обязан накрывать сам элемент: иначе это декор, а не зона нажатия.
    let cb = el;
    while (cb && getComputedStyle(cb).position === "static") cb = cb.parentElement;
    const cr = (cb || document.body).getBoundingClientRect();
    const left = cr.left + (parseFloat(ps.left) || 0);
    const top = cr.top + (parseFloat(ps.top) || 0);
    const covers = left <= r.left + 2 && top <= r.top + 2 && left + pw >= r.right - 2 && top + ph >= r.bottom - 2;
    return covers ? { w: Math.max(r.width, pw), h: Math.max(r.height, ph) } : null;
  };
  const clsOf = (el) => (el.className && typeof el.className === "string" ? el.className.slice(0, 40) : "");

  const small = [];
  for (const el of root.querySelectorAll("a, button, input, select, textarea, [role=button], [role=tab], [tabindex]")) {
    // Programmatic focus anchors and chart graphics are not independent tap controls.
    // Native controls still count even when they have tabindex=-1.
    if (!el.matches("a,button,input,select,textarea,[role=button],[role=tab]") && (el.getAttribute("tabindex") === "-1" || el instanceof SVGElement)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || !inView(r) || !vis(el)) continue;
    if (el.tagName === "INPUT" && (el.type === "hidden" || el.type === "checkbox" || el.type === "radio") && r.width < 44) {
      // скрытые «настоящие» чекбоксы под стилизованной меткой — не цель
      if (el.closest("label")) continue;
    }
    if (r.width >= 44 && r.height >= 44) continue;
    const hit = hitBox(el, r);
    const zone = afterZone(el, r);
    if (zone) {
      hit.w = Math.max(hit.w, zone.w);
      hit.h = Math.max(hit.h, zone.h);
    }
    if (hit.w >= 44 && hit.h >= 44) continue;
    // Строку списка открывает накладка-ссылка на всю площадь строки: надпись
    // внутри — не самостоятельная цель в 23 px, а надпись поверх цели в 56+.
    const rowBox = el.closest(".row, .dlg-row");
    if (rowBox) {
      const rb = rowBox.getBoundingClientRect();
      const corner = document.elementFromPoint(Math.round(rb.left + 6), Math.round(rb.bottom - 4));
      const overlay = corner && corner.closest("a, button");
      if (overlay && rowBox.contains(overlay) && overlay !== el) {
        const ob = overlay.getBoundingClientRect();
        if (ob.width >= rb.width - 2 && ob.height >= rb.height - 2 && rb.height >= 44) continue;
      }
    }
    small.push({
      key: `${el.tagName}|${clsOf(el)}|${(el.textContent || "").trim().slice(0, 24)}|${Math.round(r.width)}x${Math.round(r.height)}`,
      tag: el.tagName.toLowerCase(),
      cls: clsOf(el),
      text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24),
      w: round(r.width),
      h: round(r.height),
      hitW: round(hit.w),
      hitH: round(hit.h),
    });
  }

  const tiny = [];
  for (const el of root.querySelectorAll("*")) {
    if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
    if (!(el.firstChild.textContent || "").trim()) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || !vis(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs >= 13) continue;
    tiny.push({
      key: `${el.tagName}|${clsOf(el)}|${(el.textContent || "").trim().slice(0, 24)}`,
      tag: el.tagName.toLowerCase(),
      cls: clsOf(el),
      fs: round(fs),
      text: (el.textContent || "").trim().slice(0, 24),
    });
  }

  // Горизонтальный вылет: считаем только то, что НЕЛЬЗЯ доскроллить. Срезы и
  // фильтры внутри боковых лент обязаны быть шире окна — это не дефект.
  const scrollerOf = (el) => {
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  const over = [];
  for (const el of root.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || !inView(r)) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    // Standard screen-reader-only text is intentionally clipped into a 1px
    // box. A revealed/focused skip link is full-size and remains measured.
    if (r.width <= 1 && r.height <= 1 && (cs.clip !== "auto" || cs.clipPath !== "none")) continue;
    // fixed-подложки и декор за пределами экрана — часть оформления, не вёрстка
    if (cs.position === "fixed" && cs.pointerEvents === "none") continue;
    const pokesOut = r.right > vw + 1;
    const clips = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const clipped = clips && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.textOverflow !== "ellipsis";
    if (!pokesOut && !clipped) continue;
    if (scrollerOf(el)) continue;
    over.push({
      key: `${el.tagName}|${clsOf(el)}|${pokesOut ? "out" : "clip"}`,
      tag: el.tagName.toLowerCase(),
      cls: clsOf(el),
      kind: pokesOut ? "за экран" : "обрезано",
      right: Math.round(r.right),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
    });
  }

  // Контраст: фон берётся из отрисованного документа (первый непрозрачный
  // предок), а не константой; крупный текст идёт по норме 3,0.
  const rgb = (v) => {
    const m = /rgba?\(([^)]+)\)/.exec(v || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.95) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lowContrast = [];
  for (const el of root.querySelectorAll("*")) {
    if (!el.firstChild || el.firstChild.nodeType !== 3) continue;
    if (!(el.firstChild.textContent || "").trim()) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || !vis(el)) continue;
    const cs = getComputedStyle(el);
    const fg0 = rgb(cs.color);
    if (!fg0) continue;
    const bg = bgOf(el);
    const fg =
      fg0.a < 1
        ? { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) }
        : fg0;
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const fs = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = fs >= 24 || (bold && fs >= 18.66) ? 3 : 4.5;
    if (ratio >= need) continue;
    lowContrast.push({
      key: `${el.tagName}|${clsOf(el)}|${(el.textContent || "").trim().slice(0, 24)}`,
      tag: el.tagName.toLowerCase(),
      cls: clsOf(el),
      ratio: Math.round(ratio * 100) / 100,
      need,
      text: (el.textContent || "").trim().slice(0, 24),
    });
  }
  /* ── R2 (06.10.2026): класс «текст наезжает / вылезает за рамки» ── */
  const selOf = (el) => {
    const one = (n) => {
      const c = n.className && typeof n.className === "string" ? n.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      return `${n.tagName.toLowerCase()}${c ? "." + c : ""}`;
    };
    const p = el.parentElement;
    return p && p !== document.body ? `${one(p)} > ${one(el)}` : one(el);
  };
  const ownText = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  };
  // Элемент или предок спрятан: aria-hidden / inert / opacity 0 / visibility hidden.
  const hiddenCache = new WeakMap();
  const hidden = (el) => {
    if (!el || el === document.documentElement) return false;
    if (hiddenCache.has(el)) return hiddenCache.get(el);
    let h = false;
    const par = el.parentElement;
    // Содержимое закрытого `<details>` (кроме `<summary>`) не рисуется, хотя прямоугольники есть.
    if (par && par.tagName === "DETAILS" && !par.open && el.tagName !== "SUMMARY") h = true;
    else if (el.getAttribute && (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert"))) h = true;
    else {
      const cs = getComputedStyle(el);
      h = cs.opacity === "0" || cs.visibility === "hidden" || cs.display === "none" || hidden(el.parentElement);
    }
    hiddenCache.set(el, h);
    return h;
  };

  // «Свой» слой: сам элемент, его родня или накладка-ссылка той же строки/карточки
  // (растянутая `.rh-row-link::after` лежит поверх чипов и надписей строки).
  const sameLayer = (el, t) => {
    if (!t) return false;
    if (t === el || el.contains(t) || t.contains(el)) return true;
    const box = el.closest(".row, .card, .tile, li");
    return !!box && box.contains(t);
  };
  // В режиме шторки считаем только то, что лежит на верхнем слое (не под подложкой).
  const onTopLayer = (el, r) => {
    const hx = Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width, 40) / 2));
    const hy = Math.min(vh - 1, Math.max(0, r.top + Math.min(r.height, 40) / 2));
    const t = document.elementFromPoint(hx, hy);
    return sameLayer(el, t);
  };

  // Видимая часть строки: обрезаем рамками предков и самого элемента с overflow не
  // visible (многоточие и скрытое переполнение прячут хвост, Range же отдаёт ширину
  // полного текста).
  const clipCache = new WeakMap();
  const clipOf = (el) => {
    if (!el || el === document.documentElement) return null;
    if (clipCache.has(el)) return clipCache.get(el);
    const up = clipOf(el.parentElement);
    const cs = getComputedStyle(el);
    let box = up;
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
      const r = el.getBoundingClientRect();
      const mine = {
        left: cs.overflowX !== "visible" ? r.left : -Infinity,
        right: cs.overflowX !== "visible" ? r.right : Infinity,
        top: cs.overflowY !== "visible" ? r.top : -Infinity,
        bottom: cs.overflowY !== "visible" ? r.bottom : Infinity,
      };
      box = up
        ? { left: Math.max(up.left, mine.left), right: Math.min(up.right, mine.right), top: Math.max(up.top, mine.top), bottom: Math.min(up.bottom, mine.bottom) }
        : mine;
    }
    clipCache.set(el, box);
    return box;
  };

  // 1. Наезд: пары строк текста (прямоугольники Range по узлам текста).
  const leaves = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
    const txt = ownText(el);
    if (!txt) continue;
    const bb = el.getBoundingClientRect();
    if (bb.width === 0 || bb.height === 0 || !inView(bb)) continue;
    if (hidden(el)) continue;
    const rects = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !(n.textContent || "").trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      const clip = clipOf(el);
      for (const raw of rg.getClientRects()) {
        const rr = clip
          ? {
              left: Math.max(raw.left, clip.left),
              right: Math.min(raw.right, clip.right),
              top: Math.max(raw.top, clip.top),
              bottom: Math.min(raw.bottom, clip.bottom),
            }
          : { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom };
        rr.width = rr.right - rr.left;
        rr.height = rr.bottom - rr.top;
        if (rr.width < 2 || rr.height < 2) continue;
        if (rr.bottom <= 0 || rr.top >= vh || rr.right <= 0 || rr.left >= vw) continue;
        // строка видна, только если в её середине сверху лежит она сама (или родня):
        // текст под шторкой/плашкой с подложкой не считается
        const hx = Math.min(vw - 1, Math.max(0, rr.left + rr.width / 2));
        const hy = Math.min(vh - 1, Math.max(0, rr.top + rr.height / 2));
        const top = document.elementFromPoint(hx, hy);
        if (!sameLayer(el, top)) continue;
        rects.push(rr);
      }
    }
    if (rects.length) leaves.push({ el, txt, rects });
  }
  const overlaps = [];
  const seenPair = new Set();
  for (let i = 0; i < leaves.length; i += 1) {
    for (let j = i + 1; j < leaves.length; j += 1) {
      const a = leaves[i];
      const b = leaves[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      let hit = null;
      outer: for (const ra of a.rects) {
        for (const rb of b.rects) {
          const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (ox > 4 && oy > 4) {
            hit = { ra, rb, ox, oy };
            break outer;
          }
        }
      }
      if (!hit) continue;
      const key = `${a.txt.slice(0, 20)}|${b.txt.slice(0, 20)}|${selOf(a.el)}|${selOf(b.el)}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      overlaps.push({
        key,
        a: a.txt.slice(0, 40),
        b: b.txt.slice(0, 40),
        selA: selOf(a.el),
        selB: selOf(b.el),
        px: `${Math.round(hit.ox)}x${Math.round(hit.oy)}`,
      });
    }
  }

  // 2. Молчаливая обрезка: overflow hidden/clip, содержимое шире/выше рамки,
  //    а многоточия или line-clamp нет.
  const clippedText = [];
  for (const el of root.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const hx = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const hy = cs.overflowY === "hidden" || cs.overflowY === "clip";
    if (!hx && !hy) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || !inView(r) || !vis(el)) continue;
    if (layerOnly && !onTopLayer(el, r)) continue;
    const dx = el.scrollWidth - el.clientWidth;
    const dy = el.scrollHeight - el.clientHeight;
    const cutX = hx && dx > 2;
    const cutY = hy && dy > 2;
    if (!cutX && !cutY) continue;
    // Многоточие работает только у блока со строкой текста; у flex/grid-контейнера
    // `text-overflow` молчит, и хвост режется без точек (плитки `.pstat` в ленте).
    const flexy = /flex|grid/.test(cs.display);
    if (cs.textOverflow === "ellipsis" && !flexy) continue;
    const lc = cs.webkitLineClamp;
    if (lc && lc !== "none") continue;
    const txt = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!txt) continue;
    if (hidden(el)) continue;
    clippedText.push({
      key: `${selOf(el)}|${txt.slice(0, 24)}|${cutX ? "x" : "y"}`,
      text: txt.slice(0, 40),
      sel: selOf(el),
      by: cutX ? `${Math.round(dx)} px по ширине` : `${Math.round(dy)} px по высоте`,
    });
  }

  // 3. Вылет: текст или нажимаемое выходит за правый край окна или своей карточки.
  const outOfBounds = [];
  for (const el of root.querySelectorAll("*")) {
    const tag = el.tagName;
    const interactive = tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "IMG";
    const txt = ownText(el);
    if (!txt && !interactive) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || !inView(r) || !vis(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed" && cs.pointerEvents === "none") continue;
    if (scrollerOf(el)) continue;
    if (hidden(el)) continue;
    if (layerOnly && !onTopLayer(el, r)) continue;
    let why = null;
    if (r.right > vw + 2) why = `за край окна на ${Math.round(r.right - vw)} px`;
    if (!why) {
      const box = el.parentElement && el.parentElement.closest(".card, .row, .sheet");
      if (box) {
        const br = box.getBoundingClientRect();
        if (br.width > 0 && r.right > br.right + 2) why = `за край карточки на ${Math.round(r.right - br.right)} px`;
      }
    }
    if (!why) continue;
    outOfBounds.push({
      key: `${selOf(el)}|${(txt || tag).slice(0, 24)}|${why.split(" на ")[0]}`,
      text: (txt || tag.toLowerCase()).slice(0, 40),
      sel: selOf(el),
      by: why,
    });
  }
  return { small, tiny, over, lowContrast, overlaps, clippedText, outOfBounds };
}

/**
 * Замеры, которые не зависят от прокрутки: стекло, шапки, узлы, текст.
 * `backdropFilterLayers` — видимые fixed/sticky элементы с `backdrop-filter`
 * (на телефоне больше одного слоя одновременно контракт запрещает).
 */
export function staticMetrics() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  let glass = 0;
  const glassList = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (!bf || bf === "none") continue;
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (!vis(el)) continue;
    glass += 1;
    glassList.push(`${el.tagName.toLowerCase()}.${String(el.className || "").slice(0, 30)}`);
  }
  const headers = [...document.querySelectorAll("[data-topbar], .rh2 .mh > .top")].filter(vis).length;
  const pageRoot = document.querySelector("[data-page-enter]") || document.querySelector("main") || document.body;
  const conversation = pageRoot.querySelector(".clean-conversation");
  const conversationBody = conversation?.querySelector('.thread[aria-label="Переписка"]');
  const back = conversation?.querySelector('button[aria-label="Назад к списку чатов"]');
  return {
    backdropFilterLayers: glass,
    backdropFilterList: glassList.slice(0, 6),
    fixedHeaders: headers,
    domNodes: document.getElementsByTagName("*").length,
    textLen: (pageRoot.innerText || "").trim().length,
    conversationText: conversation ? {
      label: (conversation.getAttribute("aria-label") || "").trim(),
      visible: vis(conversation),
      bodyPresent: !!conversationBody && vis(conversationBody),
      bodyTextLen: conversationBody && vis(conversationBody) ? (conversationBody.innerText || "").trim().length : 0,
      backVisible: !!back && vis(back),
    } : null,
    domTheme: document.documentElement.getAttribute("data-theme"),
    innerWidth: window.innerWidth,
    pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}

/**
 * Сводка шагов прокрутки: объединяет списки по `key` и отдаёт числа.
 * Хранит по 8 первых примеров на категорию, чтобы json не пух.
 */
export function mergeProbes(steps) {
  const uniq = (name) => {
    const seen = new Map();
    for (const s of steps) for (const it of s[name]) if (!seen.has(it.key)) seen.set(it.key, it);
    return [...seen.values()];
  };
  const small = uniq("small");
  const tiny = uniq("tiny");
  const over = uniq("over");
  const low = uniq("lowContrast");
  const ov = uniq("overlaps");
  const cl = uniq("clippedText");
  const ob = uniq("outOfBounds");
  const strip = ({ key, ...rest }) => rest;
  return {
    tapTargetsBelow44: small.length,
    tapTargetsDetail: small.slice(0, 8).map(strip),
    fontsBelow13: tiny.length,
    fontsDetail: tiny.slice(0, 8).map(strip),
    overflowX: over.length > 0,
    overflowDetail: over.slice(0, 8).map(strip),
    lowContrastCount: low.length,
    lowContrastDetail: low.slice(0, 8).map(strip),
    overlapCount: ov.length,
    overlapDetail: ov.slice(0, 16).map(strip),
    clippedTextCount: cl.length,
    clippedTextDetail: cl.slice(0, 16).map(strip),
    outOfBoundsCount: ob.length,
    outOfBoundsDetail: ob.slice(0, 16).map(strip),
  };
}

/**
 * Свидетель кадра. Кадр доказывает ровно то, что на нём отрисовано, поэтому у
 * каждой ячейки есть число, СЧИТАННОЕ СО СТРАНИЦЫ: ширина окна, тема, непустота
 * и то, что мы не на экране входа. Возвращает массив замечаний (пустой — всё ок).
 */
export function witness(seen, { label, expectTheme, expectWidth, minText = 40 }) {
  const out = [];
  if (seen.innerWidth !== expectWidth) out.push(`${label}: ширина ${seen.innerWidth}, ожидали ${expectWidth}`);
  if (expectTheme && seen.domTheme !== expectTheme) out.push(`${label}: тема «${seen.domTheme}», ожидали «${expectTheme}»`);
  if (seen.textLen < minText) out.push(`${label}: на экране ${seen.textLen} знаков текста — экран пустой или не загрузился`);
  return out;
}

/* ───────────────────────────── сравнение кадров ───────────────────────────── */

/**
 * Попиксельная разница двух PNG через `pngjs`. Пиксель «отличается», если
 * наибольшая разница по каналам больше `threshold` (из 255). Разный размер
 * кадров = 100 %. Возвращает процент отличающихся пикселей или `null`, если
 * одного из файлов нет.
 */
export function diffPercent(fileA, fileB, threshold = 24) {
  if (!existsSync(fileA) || !existsSync(fileB)) return null;
  const { PNG } = require("pngjs");
  const a = PNG.sync.read(readFileSync(fileA));
  const b = PNG.sync.read(readFileSync(fileB));
  if (a.width !== b.width || a.height !== b.height) return 100;
  const total = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2])
    );
    if (d > threshold) diff += 1;
  }
  return Math.round((diff / total) * 10000) / 100;
}

/** Предыдущий прогон: самая свежая (по времени `summary.json`) папка, кроме текущей. */
export function previousRun(parityDir, current) {
  if (!existsSync(parityDir)) return null;
  const cur = path.basename(path.resolve(current));
  const dirs = readdirSync(parityDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== cur && existsSync(path.join(parityDir, d.name, "summary.json")))
    .map((d) => ({ name: d.name, t: statSync(path.join(parityDir, d.name, "summary.json")).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  return dirs.length ? path.join(parityDir, dirs[dirs.length - 1].name) : null;
}

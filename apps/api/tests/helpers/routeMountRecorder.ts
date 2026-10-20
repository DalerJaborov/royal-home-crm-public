import Router from "router";

/**
 * ЗАПИСЬ ПУТЕЙ МОНТИРОВАНИЯ РОУТЕРОВ (10.10.2026) — для тестов, обходящих все роуты.
 *
 * Express 5 (пакет router) не хранит строку пути у слоя `app.use("/api/v1/x", r)`:
 * остаётся только скомпилированный матчер. Чтобы собрать полные пути зарегистрированных
 * роутов, этот модуль оборачивает `Router.prototype.use` и помечает созданные слои
 * `mountPath`. Импортировать ПЕРВЫМ, до `../src/app.js` — иначе роутеры уже собраны.
 */
type Layer = { mountPath?: unknown };
const PATCHED = Symbol.for("rh.routeMountRecorder");
type UseFn = ((...args: unknown[]) => unknown) & { [PATCHED]?: true };
const proto = (Router as unknown as { prototype: { use: UseFn; stack?: Layer[] } }).prototype;

// Пакет `router` не изолируется vitest между файлами одного процесса, поэтому
// обёртка ставится ровно один раз: повторный импорт помощника не оборачивает
// уже обёрнутое.
if (!proto.use[PATCHED]) {
  const originalUse = proto.use;
  const patchedUse: UseFn = function patchedUse(this: { stack: Layer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const first = args[0];
    const mount = typeof first === "string" || Array.isArray(first) ? first : "/";
    for (const layer of this.stack.slice(before)) layer.mountPath = mount;
    return result;
  };
  patchedUse[PATCHED] = true;
  proto.use = patchedUse;
}

export interface RegisteredRoute {
  method: string;
  path: string;
}

type RouteLike = { path: unknown; methods: Record<string, boolean> };
type LayerLike = { route?: RouteLike; handle?: { stack?: LayerLike[] }; mountPath?: unknown };

function asPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(asPaths);
  return [];
}

function join(prefix: string, path: string): string {
  if (path === "/" || path === "") return prefix || "/";
  return `${prefix}${path.startsWith("/") ? "" : "/"}${path}`.replace(/\/{2,}/g, "/");
}

/** Рекурсивно собирает {method, path} всех роутов приложения (express 5: app.router). */
export function collectRoutes(stack: LayerLike[], prefix = ""): RegisteredRoute[] {
  const out: RegisteredRoute[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const p of asPaths(layer.route.path)) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method: method.toUpperCase(), path: join(prefix, p) });
        }
      }
    } else if (layer.handle?.stack) {
      const mounts = asPaths(layer.mountPath ?? "/");
      for (const mount of mounts.length ? mounts : ["/"]) {
        out.push(...collectRoutes(layer.handle.stack, join(prefix, mount === "/" ? "" : mount)));
      }
    }
  }
  return out;
}

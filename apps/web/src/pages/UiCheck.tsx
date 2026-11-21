import { useEffect, useRef, useState } from "react";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { useScrollLock } from "../hooks/useScrollLock";
import { layoutViewportHeight, readKeyboard } from "../lib/keyboardInset";

/**
 * «ПРОВЕРКА ЭКРАНА» (20.11.2026): цифры, по которым видно, почему на iPhone нижняя шторка не доходит до низа
 * (серая полоса ~62 px) и уезжает переписка при клавиатуре. Починка этих двух багов проверена только в
 * WebKit с подменой visualViewport — настоящий телефон Playwright не воспроизводит. Владелец открывает
 * /ui-check на своём iPhone (из приложения на экране «Домой», как работает), нажимает «Открыть пробную
 * шторку» и присылает скриншот: из него видно, чем отличаются высота окна, видимая область и экран.
 * Ничего никуда не отправляется — только показывается на экране. Доступно любому вошедшему сотруднику.
 */
type Snapshot = Record<string, string>;

function readSnapshot(probe: HTMLElement | null): Snapshot {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const safe = probe ? getComputedStyle(probe) : null;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const num = (value: number | undefined) => (value === undefined ? "нет" : String(Math.round(value * 10) / 10));
  return {
    "Окно: ширина × высота (innerHeight)": `${window.innerWidth} × ${window.innerHeight}`,
    "Видимая область: высота (visualViewport.height)": num(vv?.height),
    "Видимая область: сдвиг сверху (offsetTop)": num(vv?.offsetTop),
    "Видимая область: масштаб": num(vv?.scale),
    "Экран: ширина × высота (screen)": `${screen.width} × ${screen.height}`,
    "Плотность пикселей": num(window.devicePixelRatio),
    "Отступ safe-area: сверху": safe?.paddingTop ?? "нет",
    "Отступ safe-area: снизу": safe?.paddingBottom ?? "нет",
    "Выше низа видимой области (vv.top + vv.h − innerHeight)": vv ? num(vv.offsetTop + vv.height - window.innerHeight) : "нет",
    "Режим «на экране Домой» (standalone)": standalone ? "да" : "нет",
    "Высота страницы (clientHeight)": String(document.documentElement.clientHeight),
    "Прокрутка страницы (scrollY)": num(window.scrollY),
    "Клавиатура по новому расчёту": vv ? (readKeyboard(layoutViewportHeight(), vv).open ? "открыта" : "закрыта") : "нет",
    "Клавиатура по старому расчёту (innerHeight)": vv ? (readKeyboard(window.innerHeight, vv).open ? "открыта" : "закрыта") : "нет",
    "--rh-vv-over (запас шторки)": rootStyle.getPropertyValue("--rh-vv-over").trim() || "не задан (шторка закрыта)",
    "--clean-viewport-top": rootStyle.getPropertyValue("--clean-viewport-top").trim() || "не задан",
    "--clean-viewport-height": rootStyle.getPropertyValue("--clean-viewport-height").trim() || "не задан",
    "Вид (data-ui-look)": root.dataset.uiLook ?? "нет",
    "Браузер (User-Agent)": navigator.userAgent,
  };
}

/**
 * ПРОБНАЯ ПЕРЕПИСКА С КЛАВИАТУРОЙ (21.11.2026). Тот же каркас, что у переписки на телефоне: слой на весь
 * экран по `--clean-viewport-top`/`--clean-viewport-height` (hooks/useCleanViewport.ts), страница под ним
 * заблокирована (useScrollLock). Цифры — крупно в верхней части, над клавиатурой: владелец нажимает в поле,
 * клавиатура открывается, и один снимок экрана показывает, где стоит поле и есть ли пустота под ним.
 */
function KeyboardProbe({ onClose }: { onClose: () => void }) {
  useScrollLock(true);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [rows, setRows] = useState<[string, string][]>([]);
  useEffect(() => {
    const update = () => {
      const vv = window.visualViewport;
      const field = fieldRef.current?.getBoundingClientRect();
      const visibleBottom = vv ? vv.height : window.innerHeight;
      const kb = vv ? readKeyboard(layoutViewportHeight(), vv) : null;
      const r = (n: number | undefined) => (n === undefined ? "нет" : String(Math.round(n)));
      setRows([
        ["Пустота под полем, px", field ? r(visibleBottom - field.bottom) : "нет"],
        ["Верх поля от верха экрана, px", r(field?.top)],
        ["Видимая область: высота / сдвиг", vv ? `${r(vv.height)} / ${r(vv.offsetTop)}` : "нет"],
        ["Окно: innerHeight / clientHeight", `${window.innerHeight} / ${document.documentElement.clientHeight}`],
        ["Клавиатура: новый / старый расчёт", kb && vv ? `${kb.open ? "да" : "нет"} / ${readKeyboard(window.innerHeight, vv).open ? "да" : "нет"}` : "нет"],
        ["Каркас: верх / высота", `${getComputedStyle(document.documentElement).getPropertyValue("--clean-viewport-top").trim() || "—"} / ${getComputedStyle(document.documentElement).getPropertyValue("--clean-viewport-height").trim() || "—"}`],
        ["Прокрутка страницы", r(window.scrollY)],
      ]);
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    const timer = window.setInterval(update, 300);
    return () => { vv?.removeEventListener("resize", update); vv?.removeEventListener("scroll", update); window.clearInterval(timer); };
  }, []);
  return (
    <section data-ui-check-keyboard aria-label="Пробная переписка"
      style={{ position: "fixed", zIndex: 70, left: 0, right: 0, top: "var(--clean-viewport-top, 0px)", height: "var(--clean-viewport-height, 100dvh)", display: "flex", flexDirection: "column", background: "var(--rh-ui-bg, white)", color: "var(--rh-ui-text, inherit)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "calc(8px + env(safe-area-inset-top, 0px)) 12px 8px" }}>
        <button type="button" onClick={onClose} style={{ minHeight: 44, padding: "0 16px", borderRadius: 999, border: "1px solid rgba(0,0,0,.15)", background: "transparent", fontSize: 16 }}>Закрыть</button>
        <b style={{ fontSize: 18 }}>Пробная переписка</b>
      </div>
      <div data-ui-check-feed style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: "0 12px" }}>
        <dl style={{ margin: 0, display: "grid", gap: 6 }}>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt style={{ fontSize: 14, color: "var(--rh-ui-hint, gray)" }}>{label}</dt>
              <dd style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div style={{ padding: "8px 12px calc(8px + env(safe-area-inset-bottom, 0px))", borderTop: "1px solid rgba(0,0,0,.08)" }}>
        <textarea ref={fieldRef} rows={1} aria-label="Пробное поле" placeholder="Нажмите сюда — откроется клавиатура"
          style={{ width: "100%", minHeight: 44, fontSize: 16, borderRadius: 22, padding: "10px 16px", border: "1px solid rgba(0,0,0,.2)", resize: "none" }} />
      </div>
    </section>
  );
}

export function UiCheck() {
  const [keyboardProbe, setKeyboardProbe] = useState(false);
  const probeRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    const update = () => setSnapshot(readSnapshot(probeRef.current));
    update();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    // Переменные шторки ставятся не событием окна, а при открытии шторки — подстраховываемся таймером.
    const timer = window.setInterval(update, 500);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main style={{ padding: "20px 16px 120px", maxWidth: 720, margin: "0 auto", color: "var(--rh-ui-text, inherit)" }}>
      {/* Невидимая проба: env() читается только через стиль настоящего элемента. */}
      <div ref={probeRef} aria-hidden="true" style={{ position: "absolute", visibility: "hidden", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }} />
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 8px" }}>Проверка экрана</h1>
      <p style={{ fontSize: 16, lineHeight: 1.5, margin: "0 0 16px" }}>
        Нажмите «Открыть пробную шторку» или «Открыть поле с клавиатурой», затем нажмите в поле, сделайте снимок экрана и пришлите. Ничего никуда не отправляется, цифры остаются только на этом экране.
      </p>
      <button type="button" onClick={() => setSheet(true)} style={{ minHeight: 48, padding: "0 20px", borderRadius: 999, border: 0, background: "var(--rh-ui-primary, rgb(43 89 255))", color: "var(--rh-ui-primary-fg, white)", fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
        Открыть пробную шторку
      </button>
      {" "}
      <button type="button" onClick={() => setKeyboardProbe(true)} style={{ minHeight: 48, padding: "0 20px", borderRadius: 999, border: 0, background: "var(--rh-ui-primary, rgb(43 89 255))", color: "var(--rh-ui-primary-fg, white)", fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
        Открыть поле с клавиатурой
      </button>
      <dl style={{ margin: 0, display: "grid", gap: 12 }}>
        {Object.entries(snapshot).map(([label, value]) => (
          <div key={label} style={{ borderBottom: "1px solid rgba(0,0,0,.08)", paddingBottom: 10 }}>
            <dt style={{ fontSize: 14, color: "var(--rh-ui-hint, gray)" }}>{label}</dt>
            <dd style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 700, overflowWrap: "anywhere" }}>{value}</dd>
          </div>
        ))}
      </dl>
      {keyboardProbe && <KeyboardProbe onClose={() => setKeyboardProbe(false)} />}
      {sheet && (
        <Rh2Sheet title="Пробная шторка" onClose={() => setSheet(false)} footer={<button type="button" className="pill" onClick={() => setSheet(false)}>Готово</button>}>
          <p style={{ fontSize: 16, lineHeight: 1.5 }}>
            Нижний край этой шторки должен лежать у самого низа экрана, без серой полосы. Значения выше обновляются сами.
          </p>
          {/* Поле нужно, чтобы проверить клавиатуру на настоящем телефоне: подвал с «Готово» должен подняться над ней,
              а нижнее меню — исчезнуть (аудит К07, 21.11.2026). */}
          <label className="fld">
            <span className="lab">Заметка</span>
            <textarea rows={3} placeholder="Нажмите сюда: откроется клавиатура" />
          </label>
        </Rh2Sheet>
      )}
    </main>
  );
}

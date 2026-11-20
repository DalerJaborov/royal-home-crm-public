import { useEffect, useRef, useState } from "react";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";

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
    "--rh-vv-over (запас шторки)": rootStyle.getPropertyValue("--rh-vv-over").trim() || "не задан (шторка закрыта)",
    "--clean-viewport-top": rootStyle.getPropertyValue("--clean-viewport-top").trim() || "не задан",
    "--clean-viewport-height": rootStyle.getPropertyValue("--clean-viewport-height").trim() || "не задан",
    "Вид (data-ui-look)": root.dataset.uiLook ?? "нет",
    "Браузер (User-Agent)": navigator.userAgent,
  };
}

export function UiCheck() {
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
    <main style={{ padding: "20px 16px 120px", maxWidth: 720, margin: "0 auto", color: "var(--rh-ui-text, #14161a)" }}>
      {/* Невидимая проба: env() читается только через стиль настоящего элемента. */}
      <div ref={probeRef} aria-hidden="true" style={{ position: "absolute", visibility: "hidden", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }} />
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 8px" }}>Проверка экрана</h1>
      <p style={{ fontSize: 16, lineHeight: 1.5, margin: "0 0 16px" }}>
        Нажмите «Открыть пробную шторку», сделайте снимок экрана и пришлите. Ничего никуда не отправляется — цифры только на этом экране.
      </p>
      <button type="button" onClick={() => setSheet(true)} style={{ minHeight: 48, padding: "0 20px", borderRadius: 999, border: 0, background: "var(--rh-ui-primary, #2b59ff)", color: "var(--rh-ui-primary-fg, #fff)", fontSize: 16, fontWeight: 600, marginBottom: 20 }}>
        Открыть пробную шторку
      </button>
      <dl style={{ margin: 0, display: "grid", gap: 12 }}>
        {Object.entries(snapshot).map(([label, value]) => (
          <div key={label} style={{ borderBottom: "1px solid rgba(0,0,0,.08)", paddingBottom: 10 }}>
            <dt style={{ fontSize: 14, color: "var(--rh-ui-hint, #646c79)" }}>{label}</dt>
            <dd style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 700, overflowWrap: "anywhere" }}>{value}</dd>
          </div>
        ))}
      </dl>
      {sheet && (
        <Rh2Sheet title="Пробная шторка" onClose={() => setSheet(false)} footer={<button type="button" className="pill" onClick={() => setSheet(false)}>Готово</button>}>
          <p style={{ fontSize: 16, lineHeight: 1.5 }}>
            Нижний край этой шторки должен лежать у самого низа экрана, без серой полосы. Значения выше обновляются сами.
          </p>
        </Rh2Sheet>
      )}
    </main>
  );
}

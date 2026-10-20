/** Runs inside the browser. Detects lost Rh2 chart styles, including the
 * opaque SVG hit rectangles missed by the earlier layout-only audit.
 * Only inspect rendered elements; hidden tabs are checked when opened. */
export function interfaceStyleProbe() {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none"
      && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const transparent = (color) => color === "none" || color === "transparent"
    || /(?:rgba|hsla)\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/.test(color);
  const issues = [];
  const shell = document.documentElement.dataset.shell === "clean" ? "clean" : "legacy";
  let hitTargets = 0;
  let chartGrids = 0;
  if (shell === "clean") for (const sheet of document.querySelectorAll('.sheet[role="dialog"]:has(.clean-record-form)')) {
    if (!visible(sheet)) continue;
    const background = getComputedStyle(sheet).backgroundColor;
    const rgba = background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
    if (transparent(background) || (rgba && Number(rgba[1]) < .99)) {
      issues.push({ type: "transparent-record-form", background });
    }
  }
  if (shell === "clean") for (const control of document.querySelectorAll('[data-clean-variant="primary"]')) {
    if (!visible(control)) continue;
    const style = getComputedStyle(control);
    if (transparent(style.backgroundColor) || style.color !== "rgb(255, 255, 255)" || style.boxShadow !== "none") {
      issues.push({ type: "clean-primary-style-overridden", label: control.textContent.trim().slice(0, 80), background: style.backgroundColor, color: style.color, shadow: style.boxShadow });
    }
  }
  for (const hit of document.querySelectorAll(".rh2 .chart .hit")) {
    if (!visible(hit)) continue;
    hitTargets += 1;
    const fill = getComputedStyle(hit).fill;
    if (!transparent(fill) && Number(getComputedStyle(hit).fillOpacity) !== 0) {
      issues.push({ type: "opaque-chart-hit", fill, scoped: !!hit.closest(".scr") });
    }
  }
  for (const grid of document.querySelectorAll(".rh2 .chart .gl")) {
    // A horizontal SVG line has zero height, so the chart is the visibility witness.
    if (!visible(grid.closest(".chart"))) continue;
    chartGrids += 1;
    const stroke = getComputedStyle(grid).stroke;
    if (transparent(stroke)) issues.push({ type: "missing-chart-grid", stroke });
  }
  for (const segment of document.querySelectorAll(".cef-overview .seg")) {
    if (!visible(segment)) continue;
    const display = getComputedStyle(segment).display;
    if (!["flex", "inline-flex", "grid", "inline-grid"].includes(display)) {
      issues.push({ type: "unstyled-finance-segment", display });
    }
  }
  for (const scope of document.querySelectorAll(".cef-overview")) {
    if (visible(scope) && !scope.querySelector(":scope > .scr")) {
      issues.push({ type: "missing-finance-scope" });
    }
  }
  for (const amount of document.querySelectorAll(".cef-overview .trio .n b > .money")) {
    if (visible(amount) && parseFloat(getComputedStyle(amount).fontSize) < 20) {
      issues.push({ type: "finance-amount-inherits-caption-size", fontSize: getComputedStyle(amount).fontSize });
    }
  }
  for (const link of document.querySelectorAll(".rh2.screens .lnk")) {
    if (!visible(link)) continue;
    const after = getComputedStyle(link, "::after");
    if (getComputedStyle(link).position === "static" && after.position === "absolute" && !["none", "normal"].includes(after.content)) {
      issues.push({ type: "unanchored-link-hit-area", label: link.textContent.trim().slice(0, 80) });
    }
  }
  return { shell, hitTargets, chartGrids, issues };
}

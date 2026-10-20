import { useEffect, useRef, useState } from "react";

export function focusSettingsSection(heading: HTMLElement) {
  const accordion = heading.closest<HTMLButtonElement>("button[aria-expanded]");
  if (accordion) {
    if (accordion.getAttribute("aria-expanded") === "false") accordion.click();
    accordion.focus({ preventScroll: true });
    accordion.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }
  const previouslyFocusable = heading.hasAttribute("tabindex");
  if (!previouslyFocusable) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ behavior: "auto", block: "start" });
  if (!previouslyFocusable) heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
}

/** Index the mounted headings, so permissions and conditional sections stay authoritative. */
export function CleanSettingsSectionJump({ panelKey, target }: { panelKey: string; target?: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<HTMLElement[]>([]);
  const focused = useRef<string | null>(null);
  useEffect(() => { focused.current = null; }, [panelKey, target]);
  useEffect(() => {
    if (!target || focused.current === target) return;
    const heading = headings.find((entry) => entry.textContent?.trim() === target);
    if (heading && heading.isConnected) {
      focused.current = target;
      focusSettingsSection(heading);
    }
  }, [headings, target]);
  useEffect(() => {
    const panel = host.current?.closest(".sset-body");
    if (!panel) return;
    const collect = () => {
      const next = [...panel.querySelectorAll<HTMLElement>("h2, h3")].filter((heading) => heading.textContent?.trim() && !heading.closest(".clean-settings-task-heading"));
      setHeadings((previous) => previous.length === next.length && previous.every((heading, index) => heading === next[index]) ? previous : next);
    };
    collect();
    const observer = new MutationObserver(collect);
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [panelKey]);
  return <div ref={host} className="clean-settings-jump" hidden={headings.length <= 1}>
    <label htmlFor="settings-section-jump">Перейти к параметрам</label>
    <select id="settings-section-jump" value="" onChange={(event) => {
      const heading = headings[Number(event.target.value)];
      if (!heading || event.target.value === "") return;
      focusSettingsSection(heading);
    }}>
      <option value="">Выберите блок · {headings.length}</option>
      {headings.map((heading, index) => <option key={index} value={index}>{heading.textContent?.trim()}</option>)}
    </select>
  </div>;
}

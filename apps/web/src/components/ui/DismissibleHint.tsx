import { Info, X } from "lucide-react";
import { useUiPrefs } from "../../store/uiPrefs";
import { usePanelPrefs } from "../../hooks/usePanelPrefs";

/**
 * Подсказка-объяснение, которую можно навсегда закрыть — тот же вид, что у
 * InlineHint (иконка + серый текст), плюс крестик. Закрытие пишется в
 * uiPrefs.dismissedHints и синкается в БД (см. store/uiPrefs.ts), поэтому
 * решение «спрятать» переживает перезагрузку и другие устройства того же
 * человека.
 *
 * `id` должен быть уникальным и стабильным на весь срок жизни подсказки —
 * смена текста не должна требовать смены id (иначе все, кто уже закрыл
 * подсказку, увидят её снова), а вот при действительно новой мысли имеет
 * смысл завести новый id.
 */
export function DismissibleHint({ id, children }: { id: string; children: React.ReactNode }) {
  const dismissed = useUiPrefs((s) => s.dismissedHints.includes(id));
  const dismissHint = useUiPrefs((s) => s.dismissHint);
  const [panelPrefs] = usePanelPrefs();
  if (dismissed) return null;
  return (
    <div
      className={`flex items-start gap-1.5 text-[15px] leading-relaxed text-gray-400 bg-line-soft rounded-lg px-3 py-2 ${
        panelPrefs.animations ? "hint-fade-in" : ""
      }`}
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      <span className="flex-1">{children}</span>
      <button
        type="button"
        onClick={() => dismissHint(id)}
        aria-label="Скрыть подсказку"
        title="Больше не показывать"
        className="tap-target shrink-0 text-gray-400 hover:text-ink -m-1 p-1"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

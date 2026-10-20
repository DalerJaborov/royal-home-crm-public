/**
 * Тумблер темы «Royal Home 2026»: разметка прототипа один в один
 * (`<label class="tgl"><input type="checkbox"><i></i></label>`,
 * docs/pult/theme-2026/screens/profile.html). Своей вёрстки здесь нет, всё
 * рисует `.rh2 .tgl` из theme-2026-proto.css; компонент нужен только чтобы не
 * копировать эти четыре строки в каждой секции профиля.
 *
 * Тап-цель 51x44 задана прототипом, поэтому правило «не меньше 44 px»
 * выполняется самой темой, а не отдельным классом приложения.
 */
export function ProtoToggle({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label className="tgl" aria-label={label}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
      <i />
    </label>
  );
}

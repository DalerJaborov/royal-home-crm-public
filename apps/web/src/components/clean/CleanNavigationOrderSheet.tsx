import { useEffect, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { NavItem } from "../../lib/navigation";
import { mergeCleanNavigationDraft, moveCleanNavigation, orderedCleanNavigation } from "../../lib/cleanNavigationOrder";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { CButton } from "./ui";

function SortableNavigationRow({ item, index, count, disabled, move }: { item: NavItem; index: number; count: number; disabled: boolean; move: (direction: -1 | 1) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.to, disabled });
  return <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }} className="flex items-center gap-3 rounded-[16px] bg-row-alt p-3">
    <CButton variant="soft" size="icon" disabled={disabled} {...attributes} {...listeners} aria-label={`Переместить ${item.label}`}><GripVertical /></CButton>
    <item.icon className="size-5 shrink-0 text-blue" aria-hidden />
    <span className="min-w-0 flex-1 break-words text-[16px] font-medium text-ink">{item.label}</span>
    <CButton variant="soft" size="icon" disabled={disabled || index === 0} aria-label={`${item.label}: выше`} onClick={() => move(-1)}><ArrowUp /></CButton>
    <CButton variant="soft" size="icon" disabled={disabled || index === count - 1} aria-label={`${item.label}: ниже`} onClick={() => move(1)}><ArrowDown /></CButton>
  </li>;
}

export function CleanNavigationOrderSheet({ items, savedOrder, onSave, onClose }: { items: NavItem[]; savedOrder: readonly string[]; onSave: (order: string[]) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => orderedCleanNavigation([], items, savedOrder).map((item) => item.to));
  const [reset, setReset] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const mounted = useRef(true);
  const dragging = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const allowed = new Map(items.map((item) => [item.to, item]));
  const visible = [...new Set([...draft, ...items.map((item) => item.to)])].filter((id) => allowed.has(id));
  const move = (id: string, target: string) => { const next = moveCleanNavigation(visible, id, target); setDraft(next); setAnnouncement(`${allowed.get(id)?.label ?? "Раздел"}: позиция ${next.indexOf(id) + 1} из ${next.length}`); setReset(false); setError(null); };
  const save = async () => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await onSave(reset ? [] : mergeCleanNavigationDraft(savedOrder, visible, [...allowed.keys()]));
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "Не удалось сохранить порядок. Попробуйте ещё раз."); setSaving(false); }
    }
  };
  return <Rh2Sheet title="Порядок вкладок" onClose={() => { if (!dragging.current) onClose(); }} dismissible={!saving} onSubmit={(event) => { event.preventDefault(); void save(); }} footer={<div className="flex flex-wrap justify-end gap-3"><CButton variant="soft" disabled={saving} onClick={onClose}>Отмена</CButton><CButton type="submit" disabled={saving}>{saving ? "Сохраняем…" : "Сохранить"}</CButton></div>}>
    <div className="space-y-5">
      <p className="text-[16px] leading-relaxed text-gray-500">Перетащите раздел за ручку или используйте стрелки. Первые разделы появятся в шапке, остальные — в «Ещё». Порядок сохранится в вашем профиле.</p>
      <p className="text-[14px] text-gray-500">Клавиатура: выберите ручку, нажмите пробел, перемещайте стрелками и снова нажмите пробел. Esc отменяет перетаскивание.</p>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      <DndContext accessibility={{ screenReaderInstructions: { draggable: "Пробел — взять раздел, стрелки — переместить, пробел — положить, Escape — отменить." }, announcements: {
        onDragStart: ({ active }) => `Взят раздел ${allowed.get(String(active.id))?.label ?? ""}.`,
        onDragOver: ({ over }) => over ? `Позиция ${visible.indexOf(String(over.id)) + 1} из ${visible.length}.` : "Вне списка.",
        onDragEnd: () => "Перемещение завершено.", onDragCancel: () => "Перемещение отменено.",
      } }} sensors={sensors} collisionDetection={closestCenter} onDragStart={() => { dragging.current = true; }} onDragCancel={() => { dragging.current = false; }} onDragEnd={({ active, over }) => { dragging.current = false; if (over) move(String(active.id), String(over.id)); }}>
        <SortableContext items={visible} strategy={verticalListSortingStrategy}><ol className="space-y-2" aria-label="Разделы в вашем порядке">{visible.map((id, index) => <SortableNavigationRow key={id} item={allowed.get(id)!} index={index} count={visible.length} disabled={saving} move={(direction) => { const target = visible[index + direction]; if (target) move(id, target); }} />)}</ol></SortableContext>
      </DndContext>
      <CButton variant="soft" disabled={saving} onClick={() => { setDraft(items.map((item) => item.to)); setReset(true); setError(null); }}>Вернуть исходный порядок</CButton>
      {reset && <p className="text-[14px] text-gray-500" role="status">Исходный порядок будет применён после сохранения.</p>}
      {error && <p className="text-[16px] text-red" role="alert">{error}</p>}
    </div>
  </Rh2Sheet>;
}

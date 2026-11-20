import type { Role } from "@royal-home/shared";
import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";
import { RhButton, RhSwitch } from "../ui";
import { homeBlocksAllowed, mergeHomeOrder } from "./core";
import { HOME_BLOCKS, HOME_LAYOUT, useHomeLayoutPrefs } from "./registry";

/**
 * Профиль → Оформление → «Главная» (только «Новый вид», home-core 20.11.2026).
 *
 * Владелец: «что можно включать и отключить». Список блоков СВОЕЙ роли из реестра
 * (чужой роли блок сюда не попадает и на главную не добавляется), у каждого —
 * крупный переключатель и «выше/ниже». Переключается сразу (optimistic), сохраняется
 * в личных настройках (`home.blocks[роль]`, Agent.preferences) тем же путём, что тема.
 * Умолчание — всё включено, порядок реестра; «Вернуть как было» стирает свою запись.
 */
function Arrow({ up }: { up: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

export function HomeBlocksSettings() {
  const role = useAuthStore((s) => s.agent?.role) as Role | undefined;
  const setHomeBlocks = useUiPrefs((s) => s.setHomeBlocks);
  const { order, hidden } = useHomeLayoutPrefs(role ?? "default");
  if (!role) return null;
  const blocks = homeBlocksAllowed(role, HOME_BLOCKS, HOME_LAYOUT);
  if (blocks.length < 2) return null;
  const defaults = blocks.map((block) => block.id);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const ids = mergeHomeOrder(defaults, order);
  const off = defaults.filter((id) => hidden.has(id));
  const customized = off.length > 0 || ids.join("|") !== defaults.join("|");

  const save = (nextOrder: string[], nextHidden: string[]) => {
    const sameOrder = nextOrder.join("|") === defaults.join("|");
    setHomeBlocks(role, sameOrder && nextHidden.length === 0 ? null : {
      ...(sameOrder ? {} : { order: nextOrder }),
      ...(nextHidden.length ? { hidden: nextHidden } : {}),
    });
  };
  const toggle = (id: string, on: boolean) => save(ids, on ? off.filter((x) => x !== id) : [...off, id]);
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    save(next, off);
  };

  return (
    <section className="card" aria-labelledby="home-blocks-title">
      <div className="sec-h stack">
        <h2 id="home-blocks-title">Главная</h2>
        <span className="note">Какие блоки видно и в каком порядке</span>
      </div>
      <div className="ry-home-set" data-ry-section="home">
        <ol className="ry-home-set-list">
          {ids.map((id, index) => {
            const block = byId.get(id)!;
            const on = !hidden.has(id);
            return (
              <li key={id} className="ry-home-set-row" data-on={on ? "true" : "false"}>
                <span className="ry-home-set-name">{block.title}</span>
                <span className="ry-home-set-acts">
                  <button type="button" className="ry-home-set-move" aria-label={`Выше: ${block.title}`} disabled={index === 0} onClick={() => move(index, -1)}><Arrow up /></button>
                  <button type="button" className="ry-home-set-move" aria-label={`Ниже: ${block.title}`} disabled={index === ids.length - 1} onClick={() => move(index, 1)}><Arrow up={false} /></button>
                  <RhSwitch checked={on} label={block.title} onChange={(next) => toggle(id, next)} />
                </span>
              </li>
            );
          })}
        </ol>
        {customized && <RhButton variant="gray" onClick={() => setHomeBlocks(role, null)}>Вернуть как было</RhButton>}
      </div>
    </section>
  );
}

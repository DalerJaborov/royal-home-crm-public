import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FORMS10: счётчик «Горит сейчас» возвращается после успешной отмены (04.10.2026).
 * jsdom и Testing Library в проекте нет, поэтому React подменён минимальным
 * рантаймом useState (слоты по порядку вызова), а дерево элементов обходится
 * руками, как в property-wizard/__tests__/useWizardLocalDraft.test.ts.
 */
const rt = vi.hoisted(() => ({ slots: [] as unknown[], idx: 0 }));
const toast = vi.hoisted(() => ({ calls: [] as Array<{ onUndo?: () => Promise<void> }> }));

vi.mock("react", () => ({
  useEffect: () => undefined,
  useState: (init: unknown) => {
    const i = rt.idx++;
    if (!(i in rt.slots)) rt.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      rt.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(rt.slots[i]) : v;
    };
    return [rt.slots[i], set];
  },
}));
vi.mock("../../../hooks/useUndoToast", () => ({
  useUndoToast: () => ({ showUndoToast: (o: { onUndo?: () => Promise<void> }) => toast.calls.push(o) }),
}));

// Набор rh2 подменён строковыми типами: настоящие компоненты зовут forwardRef на
// загрузке модуля, а React в этом тесте урезан до useState.
vi.mock("../../rh2/Button", () => ({ Button: "Button", LinkButton: "LinkButton" }));
vi.mock("../../rh2/Card", () => ({ Card: "Card" }));
vi.mock("../../rh2/Row", () => ({ Row: "Row", List: "List" }));

import { ActionRow, ActionRowList, type ActionRowAction } from "../ActionRow";

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | Node[];
type El = { type?: unknown; props: Record<string, unknown> };
/** Обход всех props, а не только children: кнопки лежат в `actions` строки `Row`. */
function findAll(node: unknown, pred: (n: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((c) => findAll(c, pred, out));
  else if (node && typeof node === "object") {
    const el = node as El;
    if (el.props && typeof el.props === "object") {
      if (pred(el)) out.push(el);
      Object.values(el.props).forEach((v) => findAll(v, pred, out));
    }
  }
  return out;
}

function action(onUndo: () => Promise<void>): ActionRowAction {
  return { label: "Передать", endpoint: "POST /x", onRun: async () => true, onUndo, doneMessage: "Передано" };
}

beforeEach(() => {
  rt.slots = [];
  toast.calls = [];
});

describe("ActionRowList: счётчик после отмены", () => {
  const rows = [{ id: "client-1", tone: "warn" as const, avatar: { label: "К", tone: "lime" as const }, title: "Клиент", actions: [] }];
  const leftOf = () => {
    rt.idx = 0;
    const tree = ActionRowList({ rows }) as unknown as Node;
    const card = findAll(tree, (n) => n.type === "Card")[0];
    return { left: /· (\d+)$/.exec(String(card.props.title))?.[1], row: findAll(tree, (n) => n.type === ActionRow)[0] };
  };

  it("решили: 0; отменили успешно: снова 1", () => {
    expect(leftOf().left).toBe("1");
    leftOf().row.props.onDecided && (leftOf().row.props.onDecided as () => void)();
    expect(leftOf().left).toBe("0");
    const undone = leftOf().row.props.onUndone as (() => void) | undefined;
    expect(undone).toBeTypeOf("function");
    undone!();
    expect(leftOf().left).toBe("1");
  });
});

describe("ActionRow: onUndone", () => {
  async function clickAction(onUndo: () => Promise<void>, onUndone: () => void) {
    rt.idx = 0;
    const tree = ActionRow({ tone: "warn", k: "Клиенты", title: "t", actions: [action(onUndo)], onUndone }) as unknown as Node;
    const pill = findAll(tree, (n) => n.type === "Button" && typeof n.props["data-endpoint"] === "string")[0];
    await (pill.props.onClick as () => Promise<void>)();
    await toast.calls[0].onUndo!();
  }

  it("успешная отмена сообщает родителю", async () => {
    const onUndone = vi.fn();
    await clickAction(async () => undefined, onUndone);
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it("отказ отмены не сообщает: строка остаётся сделанной", async () => {
    const onUndone = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await clickAction(async () => {
      throw new Error("нет");
    }, onUndone);
    expect(onUndone).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, allowed: true, mutation: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = h.index++; if (!(index in h.states)) h.states[index] = initial;
  return [h.states[index], (value: unknown) => { h.states[index] = typeof value === "function" ? value(h.states[index]) : value; }];
} }));
vi.mock("../../lib/permissions", () => ({ useCan: () => () => h.allowed }));
vi.mock("../../hooks/useConversations", () => ({ useReplyFeedback: () => ({ isPending: false, isError: false, mutateAsync: h.mutation }) }));
import { BotReplyFeedback } from "../BotReplyFeedback";
type Element = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element;
  return [element, ...nodes(element.props.children)];
}
function render() { h.index = 0; return BotReplyFeedback({ conversationId: "chat", message: { role: "assistant", content: "Ответ" }, messageKey: "m1", index: 0 }); }
function button(tree: unknown, label: string) { return nodes(tree).find(node => node.type === "button" && node.props.children === label)!; }
beforeEach(() => { h.states = []; h.index = 0; h.allowed = true; h.mutation.mockReset(); });
describe("operator bot answer review", () => {
  it("keeps a correction editable on refusal and clears it only after a successful retry", async () => {
    (button(render(), "Неверно").props.onClick as () => void)();
    const input = nodes(render()).find(node => node.type === "input")!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: "Сначала уточните район" } });
    h.mutation.mockRejectedValueOnce(new Error("Недоступно"));
    await (button(render(), "Сохранить").props.onClick as () => Promise<void>)();
    expect(nodes(render()).find(node => node.type === "input")?.props.value).toBe("Сначала уточните район");
    h.mutation.mockResolvedValueOnce({ ok: true });
    await (button(render(), "Сохранить").props.onClick as () => Promise<void>)();
    expect(h.mutation).toHaveBeenLastCalledWith({ messageKey: "m1", index: 0, verdict: "bad", note: "Сначала уточните район" });
    expect(nodes(render()).some(node => node.type === "input")).toBe(false);
  });
  it("does not expose teaching controls without settings.manage", () => {
    h.allowed = false;
    expect(render()).toBeNull();
    expect(h.mutation).not.toHaveBeenCalled();
  });
});

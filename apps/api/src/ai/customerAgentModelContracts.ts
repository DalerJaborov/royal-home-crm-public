/** Leaf contracts shared by the bounded core and input perception. No runtime,
 * renderer, database, transport or authority dependencies. */
export interface CustomerAgentAwaitContext { readonly signal: AbortSignal; readonly deadlineAt: number }
export interface CustomerAgentModelTurn {
  text: string; calls: readonly { name: string; args: unknown; id?: string }[];
  modelParts: readonly unknown[];
}

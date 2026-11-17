/** A normal working tab is narrow; search and explicit drilldowns retain history. */
export function clientListScope(options: {
  allMine: boolean;
  other: boolean;
  searching: boolean;
  status?: string;
  workStatus?: string;
  pending: boolean;
  noResponseYesterday: boolean;
}): "allMine" | "inWork" | undefined {
  if (options.allMine) return "allMine";
  if (options.other || options.searching || options.status || options.workStatus || options.pending || options.noResponseYesterday) return undefined;
  return "inWork";
}

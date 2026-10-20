/** Pure boundary reader. Stored preferences cannot supply links or import navigation. */
export function readCleanNavigationOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path): path is string => typeof path === "string" && path.length <= 96 && /^\/(?:[a-z0-9][a-z0-9/-]*)?$/.test(path)))].slice(0, 64);
}

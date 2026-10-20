/** The CRM_MEDIA identifier convention, shared by ads and customer resolution. */
export const CRM_PUBLISHED_POST_KEYS = ["INSTAGRAM", "FACEBOOK", "FACEBOOK_POST"] as const;
export function crmMediaKeys(raw: string | null | undefined): string[] {
  const id = raw?.trim();
  if (!id) return [];
  const tail = id.includes("_") ? id.slice(id.lastIndexOf("_") + 1) : "";
  return tail && tail !== id ? [id, tail] : [id];
}

/** Matches marketing queue/editor queue role gates; object moderation alone does not grant queue access. */
export function canReadPreparation(role: string | undefined): boolean {
  return role === "MARKETING" || role === "EDITOR" || role === "DIRECTOR" || role === "ADMIN";
}

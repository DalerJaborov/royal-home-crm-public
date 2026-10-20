/** Agent phone preview is an explicit, local-only choice and never a rollout flag. */
export function agentMobilePreviewEnabled(search: string, hostname: string, previewBuild: boolean): boolean {
  const params = new URLSearchParams(search);
  return localPreviewAllowed(hostname, previewBuild)
    && params.get("shell") === "clean" && params.get("agentMobilePreview") === "1";
}

export function localPreviewAllowed(hostname: string, previewBuild: boolean): boolean {
  return previewBuild && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function agentMobilePreviewOverride(search: string): boolean | undefined {
  const params = new URLSearchParams(search);
  if (params.get("shell") === "legacy" || params.get("agentMobilePreview") === "0") return false;
  if (params.get("shell") === "clean" && params.get("agentMobilePreview") === "1") return true;
  return undefined;
}

export function cleanShellAllowedOnDevice(mobile: boolean, role: string | undefined, agentPreview = false): boolean {
  return !mobile || (!!role && (role !== "AGENT" || agentPreview));
}

export function localAgentPreviewAllowed(): boolean {
  return localPreviewAllowed(typeof window === "undefined" ? "" : window.location.hostname,
    import.meta.env.DEV || import.meta.env.VITE_AGENT_MOBILE_PREVIEW === "1");
}

const PREVIEW_KEY = "rh-agent-mobile-preview";
export function savedAgentMobilePreview(agentId: string | undefined): boolean {
  if (!agentId || !localAgentPreviewAllowed()) return false;
  try { return window.sessionStorage.getItem(`${PREVIEW_KEY}:${agentId}`) === "1"; }
  catch { return false; }
}

export function saveAgentMobilePreview(agentId: string, enabled: boolean): void {
  if (!localAgentPreviewAllowed()) return;
  if (enabled) window.sessionStorage.setItem(`${PREVIEW_KEY}:${agentId}`, "1");
  else window.sessionStorage.removeItem(`${PREVIEW_KEY}:${agentId}`);
}

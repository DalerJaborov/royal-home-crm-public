export type CustomerPropertyUrl =
  | { kind: "site"; url: string }
  | { kind: "instagram"; shortcode: string; url: string }
  | { kind: "media"; mediaId: string; url: string }
  | { kind: "denied" | "unsupported" };

/** Public origins/formats only. No redirects, private grants or credential URLs. */
export function customerPropertyUrl(raw: string): CustomerPropertyUrl {
  if (raw.length > 1024) return { kind: "unsupported" };
  let url: URL;
  try { url = new URL(raw); } catch { return { kind: "unsupported" }; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return { kind: "denied" };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "royalhome.tj") {
    if (!/^\/(?:listing|kvartiry|doma|uchastki|commercial)\//i.test(url.pathname)) return { kind: "unsupported" };
    return { kind: "site", url: `https://royalhome.tj${url.pathname}` };
  }
  if (host === "instagram.com") {
    const post = /^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (post) return { kind: "instagram", shortcode: post[1], url: `https://www.instagram.com/p/${post[1]}/` };
    const story = /^\/stories\/[^/]+\/(\d+)\/?$/.exec(url.pathname);
    if (story) return { kind: "media", mediaId: story[1], url: `https://www.instagram.com${url.pathname}` };
    return { kind: "unsupported" };
  }
  if (host === "facebook.com" || host === "m.facebook.com") {
    const post = /\/(?:reel|posts|videos)\/([\d_]+)\/?$/.exec(url.pathname);
    const video = url.pathname === "/watch/" ? url.searchParams.get("v") : null;
    const story = url.pathname === "/story.php" ? url.searchParams.get("story_fbid") : null;
    const page = url.searchParams.get("id");
    const id = post?.[1] ?? (video && /^\d+$/.test(video) ? video : null) ??
      (story && /^\d+$/.test(story) ? page && /^\d+$/.test(page) ? `${page}_${story}` : story : null);
    if (id) return { kind: "media", mediaId: id, url: `https://www.facebook.com/posts/${id}` };
    return { kind: "unsupported" };
  }
  return { kind: "denied" };
}

export function safeCustomerPropertyLink(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = customerPropertyUrl(raw);
  return "url" in parsed ? parsed.url : null;
}

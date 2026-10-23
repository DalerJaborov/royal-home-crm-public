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
    const rawPath = raw.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
    if (/[\\]/.test(rawPath) || /%2f|%5c/i.test(rawPath) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)) return { kind: "denied" };
    // Website public-i18n maps these exact public listing aliases. Do not strip
    // arbitrary locale prefixes: private/unknown routes are not public cards.
    if (/^\/(?:tg\/|en\/)?listing\/preview(?:\/|$)/i.test(url.pathname)) return { kind: "denied" };
    const localized = /^\/(?:tg\/(?:khona|listing)|en\/listing)\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (localized) {
      const id = Number(localized[1]);
      if (!Number.isSafeInteger(id) || id > 2_147_483_647) return { kind: "unsupported" };
      // This number remains the WEBSITE listing ID. It is never a CRM shortId.
      return { kind: "site", url: `https://royalhome.tj/listing/${localized[1]}` };
    }
    const direct = /^\/listing\/(?:[1-9]\d*|by-crm\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i.test(url.pathname);
    const historic = /^\/(?:kvartiry|doma|uchastki|commercial)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname);
    if (!direct && !historic) return { kind: "unsupported" };
    return { kind: "site", url: `https://royalhome.tj${url.pathname}` };
  }
  if (host === "instagram.com") {
    // Both "/p/<code>" and the account-qualified "/<user>/p/<code>" shape the app shares.
    const post = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (post) return { kind: "instagram", shortcode: post[1], url: `https://www.instagram.com/p/${post[1]}/` };
    const story = /^\/stories\/[^/]+\/(\d+)\/?$/.exec(url.pathname);
    if (story) return { kind: "media", mediaId: story[1], url: `https://www.instagram.com${url.pathname}` };
    return { kind: "unsupported" };
  }
  if (host === "facebook.com" || host === "m.facebook.com" || host === "web.facebook.com") {
    // "/share/p|r|v/<code>" is an opaque short link: its post id exists only behind a
    // redirect, and following redirects is not allowed here. Unsupported by design.
    if (/^\/share\/[prv]\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return { kind: "unsupported" };
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

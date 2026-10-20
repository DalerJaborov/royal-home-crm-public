import { describe, expect, it, vi } from "vitest";
import { resolveCustomerSharedPublication } from "../src/lib/customerSharedPublication.js";

const url = "https://www.instagram.com/reel/OurSharedReel/";
const image = "https://scontent.cdninstagram.com/photo.jpg";
const video = "https://scontent.cdninstagram.com/reel.mp4";
const current = async () => {};
describe("bounded original-account shared publication resolution", () => {
  it("finds the Graph media by permalink when reel_video_id is not a Graph ID", async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ data: [
      { id: "17890001", permalink: url, media_type: "VIDEO", media_url: video },
    ] });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "12345678" }, read, current)).toEqual([{ url: video, declaredKind: "video" }]);
    expect(read.mock.calls.map(c => c[0])).toEqual([
      "/12345678?fields=id,permalink,media_type,media_url,children{id,media_type,media_url}",
      "/me/media?fields=id,permalink,media_type,media_url,children{id,media_type,media_url}&limit=100",
    ]);
  });
  it("reads real carousel children instead of treating CAROUSEL_ALBUM as unavailable", async () => {
    const read = vi.fn().mockResolvedValue({ id: "12345678", permalink: url, media_type: "CAROUSEL_ALBUM", children: {
      data: [{ id: "111", media_type: "IMAGE", media_url: image }, { id: "222", media_type: "VIDEO", media_url: video }],
    } });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "12345678" }, read, current))
      .toEqual([{ url: image, declaredKind: "image" }, { url: video, declaredKind: "video" }]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("never confuses a different permalink with the incoming publication", async () => {
    const read = vi.fn().mockResolvedValueOnce({ id: "12345678", permalink: "https://www.instagram.com/p/OTHER/", media_type: "IMAGE", media_url: image })
      .mockResolvedValueOnce({ data: [] });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "12345678" }, read, current)).toEqual([]);
  });
  it.each(["https://localhost/a.jpg", "http://scontent.cdninstagram.com/a.jpg", "https://cdninstagram.com.evil.test/a", "https://u:p@scontent.cdninstagram.com/a"])("rejects non-public asset %s", async media_url => {
    const read = vi.fn().mockResolvedValueOnce({ id: "12345678", permalink: url, media_type: "IMAGE", media_url }).mockResolvedValueOnce({ data: [] });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "12345678" }, read, current)).toEqual([]);
  });
  it("reconstructs pagination without ever following a provider next URL or its credentials", async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: [], paging: { next: "http://127.0.0.1/?access_token=other", cursors: { after: "A+B/=" } } })
      .mockResolvedValueOnce({ data: [{ id: "111", permalink: url, media_type: "IMAGE", media_url: image }] });
    expect(await resolveCustomerSharedPublication({ url }, read, current)).toEqual([{ url: image, declaredKind: "image" }]);
    expect(read.mock.calls[1][0]).toContain("&after=A%2BB%2F%3D");
    expect(read.mock.calls.some(c => /127|access_token|other/.test(c[0]))).toBe(false);
  });
  it("bounds misses to three feed pages without retries, global credentials or thumbnail substitution", async () => {
    let page = 0;
    const read = vi.fn().mockImplementation(async () => ({ data: [{ id: "111", permalink: "https://www.instagram.com/p/OTHER/", thumbnail_url: image }], paging: { next: "ignored", cursors: { after: `cursor${++page}` } } }));
    expect(await resolveCustomerSharedPublication({ url }, read, current)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("ignores an unusable provider ID and resolves the validated permalink without interpolating that ID", async () => {
    const read = vi.fn().mockResolvedValue({ data: [
      { id: "12345678", permalink: url, media_type: "IMAGE", media_url: image },
    ] });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "../me?fields=credentials" }, read, current)).toEqual([{ url: image, declaredKind: "image" }]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toMatch(/^\/me\/media\?/);
    expect(read.mock.calls[0][0]).not.toContain("credentials");
  });
  it("stops before I/O after the original claim changes", async () => {
    const read = vi.fn();
    await expect(resolveCustomerSharedPublication({ url }, read, async () => { throw Error("stale"); })).rejects.toThrow("stale");
    expect(read).not.toHaveBeenCalled();
  });
  it("stops on credential/rate-limit failures rather than scanning the feed", async () => {
    const read = vi.fn().mockResolvedValue({ unavailable: true });
    expect(await resolveCustomerSharedPublication({ url, publicationId: "12345678" }, read, current)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("does not choose an asset from two conflicting records with the same permalink", async () => {
    const read = vi.fn().mockResolvedValue({ data: [
      { id: "111", permalink: url, media_type: "IMAGE", media_url: image },
      { id: "222", permalink: url, media_type: "VIDEO", media_url: video },
    ] });
    expect(await resolveCustomerSharedPublication({ url }, read, current)).toEqual([]);
  });
});

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** @param {string} base @param {string} target */
export function within(base, target) {
  const value = relative(base, target);
  return !isAbsolute(value) && value.split(sep)[0] !== "..";
}
/** Resolve existing ancestor links BEFORE making any directories/files.
 * @param {string} path */
export function canonicalNewArtifact(path) {
  const target = resolve(path); let ancestor = dirname(target);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor); if (parent === ancestor) throw new Error("Artifact ancestor unavailable"); ancestor = parent;
  }
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, dirname(target)), basename(target));
  if (existsSync(canonical)) throw new Error("Existing artifact cannot be overwritten");
  return { target: canonical, ancestor: realpathSync(ancestor) };
}

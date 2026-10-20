/** Bottom offsets for independent lifecycles sharing one viewport. */
export function toastStackOffsets(groups: readonly (readonly number[])[], shared: boolean): number[][] {
  let below = 0;
  return groups.reduceRight<number[][]>((result, heights, group) => {
    if (!shared) below = 0;
    result[group] = new Array(heights.length);
    for (let index = heights.length - 1; index >= 0; index--) {
      result[group][index] = below;
      below += Math.max(0, heights[index]) + 8;
    }
    return result;
  }, new Array(groups.length));
}

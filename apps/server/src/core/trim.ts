// Trimming a run of chosen characters off the ends of a string, in one pass.
//
// The obvious regex — `value.replace(/\/+$/, "")` — is quadratic on a long run
// that does NOT reach the end ("////…//x"): the engine retries the run from
// every character in it. These walk in from each end once instead, so they are
// safe on text straight from a request.

export type TrimSide = "both" | "start" | "end";

/** `value` without the leading and/or trailing characters `strip` accepts. */
export function trimWhere(value: string, strip: (char: string) => boolean, side: TrimSide = "both"): string {
  let start = 0;
  let end = value.length;
  if (side !== "end") while (start < end && strip(value[start])) start += 1;
  if (side !== "start") while (end > start && strip(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** `value` without the leading and/or trailing run of any character in `chars`. */
export function trimChars(value: string, chars: string, side: TrimSide = "both"): string {
  return trimWhere(value, (char) => chars.includes(char), side);
}

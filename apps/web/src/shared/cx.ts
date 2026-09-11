// Joins class names, dropping the falsy ones — `cx("card", active && "active")`.
// A template literal gets the same classes but leaves "card " / "card  x" behind
// whenever a condition is off.
export function cx(...classes: Array<string | false | null | undefined | 0>): string {
  return classes.filter(Boolean).join(" ");
}

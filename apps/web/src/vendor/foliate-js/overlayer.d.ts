// Minimal declaration for the bits of overlayer.js we consume from TypeScript
// (allowJs is false, so the vendored .js needs an ambient surface). The static
// draw functions are passed by reference into foliate's `draw(fn, options)`.
type DrawFn = (rects: DOMRectList | DOMRect[], options?: Record<string, unknown>) => Element;

export class Overlayer {
  readonly element: SVGElement;
  add(key: string, range: Range | ((root: Node) => Range), draw: DrawFn, options?: Record<string, unknown>): void;
  remove(key: string): void;
  redraw(): void;
  hitTest(event: { x: number; y: number }): [string, Range] | [];
  static underline: DrawFn;
  static strikethrough: DrawFn;
  static squiggly: DrawFn;
  static highlight: DrawFn;
  static outline: DrawFn;
}

// view.js is a side-effect import that registers the <foliate-view> custom
// element. It has no typed exports we consume directly; the element surface we
// use is typed in reader/foliate.ts. This empty declaration lets `import
// "./view.js"` type-check under allowJs:false.
export {};

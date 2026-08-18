// Run: node --import tsx --require ./scripts/css-stub.cjs --test <files>
// A stylesheet import resolves to an empty module under node:test. Vite handles CSS imports in the
// renderer bundle; under node (tsx compiles these modules to CommonJS) they would be parsed as
// JavaScript and throw.
require.extensions['.css'] = () => {};

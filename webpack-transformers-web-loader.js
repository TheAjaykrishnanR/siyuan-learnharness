/**
 * Webpack loader for @huggingface/transformers/dist/transformers.web.js.
 *
 * SiYuan's Electron renderer exposes a read-only `process.release.name === "node"`,
 * causing transformers.web.js to select the empty `onnxruntime-node` stub instead of
 * `onnxruntime-web`. Replacing that check with `false` at build time forces the
 * Web/WASM ONNX backend cleanly with zero runtime mutation of `process`.
 */
module.exports = function forceBrowserTransformersLoader(source) {
    return source.replace(/process\?\.release\?\.name === "node"/g, "false");
};

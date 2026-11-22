// Wrangler resolves a `.wasm` import to a WebAssembly.Module (static module
// import — Workers forbids dynamic WebAssembly.instantiate of raw bytes).
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

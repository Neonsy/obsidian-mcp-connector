import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env as hfEnv } from "@huggingface/transformers";
import { __resetEnvForTesting, configureEnv, setWasmPaths } from "./onnxEnv";

type Env = {
  useBrowserCache?: boolean;
  backends: { onnx: { wasm: { wasmPaths?: string; numThreads?: number } } };
};
const e = hfEnv as unknown as Env;

const hadCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const savedPaths = e.backends.onnx.wasm.wasmPaths;
const savedThreads = e.backends.onnx.wasm.numThreads;
const savedCache = e.useBrowserCache;

function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
function restore(name: string, saved: PropertyDescriptor | undefined): void {
  if (saved) Object.defineProperty(globalThis, name, saved);
  else delete (globalThis as Record<string, unknown>)[name];
}

beforeEach(() => {
  __resetEnvForTesting();
  e.useBrowserCache = false;
});
afterEach(() => {
  __resetEnvForTesting();
  restore("caches", hadCaches);
  restore("navigator", hadNavigator);
  e.backends.onnx.wasm.wasmPaths = savedPaths;
  e.backends.onnx.wasm.numThreads = savedThreads;
  e.useBrowserCache = savedCache;
});

describe("configureEnv", () => {
  test("uses the browser cache only where the Cache API exists", () => {
    // Node 24 defines `navigator` but has no `caches`.
    setGlobal("navigator", {});
    restore("caches", undefined);
    configureEnv();
    expect(e.useBrowserCache).toBe(false);

    __resetEnvForTesting();
    setGlobal("caches", {});
    configureEnv();
    expect(e.useBrowserCache).toBe(true);
  });

  test("points ONNX at the CDN and runs on one thread by default", () => {
    configureEnv();
    expect(e.backends.onnx.wasm.wasmPaths).toBe(
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/",
    );
    expect(e.backends.onnx.wasm.numThreads).toBe(1);
  });

  test("a host-supplied wasm path replaces the CDN", () => {
    setWasmPaths("file:///cache/ort-1.26.0/");
    configureEnv();
    expect(e.backends.onnx.wasm.wasmPaths).toBe("file:///cache/ort-1.26.0/");
  });
});

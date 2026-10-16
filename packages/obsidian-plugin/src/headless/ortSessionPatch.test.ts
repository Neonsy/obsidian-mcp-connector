import { describe, expect, test } from "bun:test";
import { patchInferenceSession } from "./ortSessionPatch";

function fakeOrt() {
  const calls: Array<{ source: unknown; options: unknown }> = [];
  const ort = {
    InferenceSession: {
      create: async (source: unknown, options?: unknown) => {
        calls.push({ source, options });
        return "session";
      },
    },
  };
  return { ort, calls };
}
const files: Record<string, Uint8Array> = {
  "/m/model.onnx": new Uint8Array([1, 2, 3]),
  "/m/w.bin": new Uint8Array([9]),
};
const readFile = async (p: string) => files[p];

describe("patchInferenceSession", () => {
  test("reads a path into bytes before creating the session", async () => {
    const { ort, calls } = fakeOrt();
    const patched = patchInferenceSession(ort, readFile);
    expect(
      await patched.InferenceSession.create("/m/model.onnx", { a: 1 }),
    ).toBe("session");
    expect(calls).toEqual([
      { source: files["/m/model.onnx"], options: { a: 1 } },
    ]);
  });

  test("bytes pass through untouched", async () => {
    const { ort, calls } = fakeOrt();
    const bytes = new Uint8Array([7]);
    await patchInferenceSession(ort, readFile).InferenceSession.create(bytes);
    expect(calls[0].source).toBe(bytes);
  });

  test("external data given as paths is read, other entries are kept", async () => {
    const { ort, calls } = fakeOrt();
    const inline = new Uint8Array([5]);
    await patchInferenceSession(ort, readFile).InferenceSession.create(
      "/m/model.onnx",
      {
        graphOptimizationLevel: "all",
        externalData: [
          { path: "w.bin", data: "/m/w.bin" },
          { path: "x.bin", data: inline },
        ],
      },
    );
    expect(calls[0].options).toEqual({
      graphOptimizationLevel: "all",
      externalData: [
        { path: "w.bin", data: files["/m/w.bin"] },
        { path: "x.bin", data: inline },
      ],
    });
  });
});

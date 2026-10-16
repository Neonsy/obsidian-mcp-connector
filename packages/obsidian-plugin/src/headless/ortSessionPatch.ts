/**
 * transformers.js, on Node, hands `InferenceSession.create` a file path
 * (and file paths in `externalData`) because the native onnxruntime-node
 * it expects reads them itself. The headless bundle runs the CPU
 * onnxruntime-web build in its place, which would `fetch()` a string as
 * a URL. This reads the bytes first.
 */

type Session = {
  create: (source: unknown, options?: unknown) => Promise<unknown>;
};

export function patchInferenceSession<T extends { InferenceSession: Session }>(
  ort: T,
  readFile: (path: string) => Promise<Uint8Array>,
): T {
  const session = ort.InferenceSession;
  const create = session.create.bind(session);
  session.create = async (source, options) => {
    const bytes = typeof source === "string" ? await readFile(source) : source;
    const opts = options as { externalData?: unknown } | undefined;
    if (opts && Array.isArray(opts.externalData)) {
      const externalData = await Promise.all(
        opts.externalData.map(async (entry: { data?: unknown }) =>
          typeof entry.data === "string"
            ? { ...entry, data: await readFile(entry.data) }
            : entry,
        ),
      );
      return create(bytes, { ...opts, externalData });
    }
    return create(bytes, options);
  };
  return ort;
}

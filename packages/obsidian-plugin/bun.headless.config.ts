#!/usr/bin/env bun
/*
 * Bundles the headless server into ONE self-contained executable,
 * `dist/headless/obsidian-mcp-headless.js`, which runs under plain Node
 * 24.11 or newer (the first Node 24 LTS) with no node_modules next to it.
 *
 * The bundle is CommonJS. Node loads a file with no package.json above it,
 * and an extensionless copy on PATH, as CommonJS without relying on module
 * detection. `import.meta` does not exist in CommonJS, so the one use
 * left in the graph is rewritten away and the build fails if any remains.
 * A `package.json` beside the bundle keeps it CommonJS when it runs from
 * here, below this package's `"type": "module"`.
 *
 * It shares the tool and transport code with the desktop plugin. The one
 * thing the bundle must not contain is the real `obsidian` package
 * (declarations only), so the name is aliased to the runtime shim. No
 * `browser` condition here: the desktop config selects browser builds for
 * a few packages, and this one runs in Node.
 *
 * Semantic search needs an ONNX runtime. The native onnxruntime-node is
 * an addon and cannot live in one file, so every ONNX import resolves to
 * `ortNodeShim.cjs`, which wraps the CPU build of onnxruntime-web
 * (`ort.wasm.min.js`). Its runtime files are not in the bundle: they are
 * downloaded and pinned on first use (see `ortAssets.ts`). `sharp`, an
 * image library the text pipeline never touches, is stubbed.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const outdir = join(import.meta.dir, "dist/headless");
const outfile = join(outdir, "obsidian-mcp-headless.js");
const shim = join(import.meta.dir, "src/headless/obsidianShim.ts");
const ortShim = join(import.meta.dir, "src/headless/ortNodeShim.cjs");
const ortCpu = join(
  dirname(Bun.resolveSync("onnxruntime-web/package.json", import.meta.dir)),
  "dist/ort.wasm.min.js",
);

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/headless/main.ts")],
  outdir,
  naming: "obsidian-mcp-headless.js",
  target: "node",
  format: "cjs",
  minify: true,
  sourcemap: "none",
  banner: "#!/usr/bin/env node",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.filename": "__filename",
  },
  plugins: [
    {
      name: "obsidian-shim",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim }));
      },
    },
    {
      name: "semantic-search-runtime",
      setup(build) {
        build.onResolve(
          { filter: /^onnxruntime-(node|web(\/webgpu)?)$/ },
          () => ({
            path: ortShim,
          }),
        );
        build.onResolve({ filter: /^ort-wasm-cpu$/ }, () => ({ path: ortCpu }));
        build.onResolve({ filter: /^sharp$/ }, (args) => ({
          path: args.path,
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: "module.exports = {};",
          loader: "js",
        }));
        // transformers.js's Node build tests `import.meta` in two places,
        // for code paths this bundle never takes. Name the result they
        // would have given without a module URL.
        build.onLoad({ filter: /transformers\.node\.mjs$/ }, async (args) => ({
          contents: (await Bun.file(args.path).text())
            .split("Object(import.meta).url")
            .join("undefined")
            .split("typeof import.meta")
            .join('"undefined"'),
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error("Headless build failed");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if ((await readFile(outfile, "utf8")).includes("import.meta")) {
  console.error("Headless build failed: import.meta left in a CommonJS bundle");
  process.exit(1);
}

await writeFile(join(outdir, "package.json"), '{ "type": "commonjs" }\n');
await chmod(outfile, 0o755);
console.warn(`Built ${outfile}`);

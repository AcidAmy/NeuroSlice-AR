import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { prepareMedicalAssets, prepareTrackingAssets } from "./scripts/build-medical-assets.mjs";

const staticAssets = () => {
  let medical, tracking, files, output;
  function serve(request, response, next) {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const path = request.url?.split("?")[0].slice(1);
    const file = files.get(path);
    if (!file) return next();
    response.setHeader("Content-Type", file.type);
    response.setHeader("Content-Length", file.bytes.length);
    response.setHeader("Cache-Control", file.immutable ? "public, max-age=31536000, immutable" : "no-cache");
    response.end(request.method === "HEAD" ? undefined : file.bytes);
  }
  return {
    name: "neuroslice-static-assets",
    async configResolved(config) {
      output = resolve(config.root, config.build.outDir);
      if (config.isPreview) return;
      [medical, tracking] = await Promise.all([
        prepareMedicalAssets(config.publicDir),
        config.command === "build" ? prepareTrackingAssets(config.publicDir) : null,
      ]);
      files = new Map([...medical.files, ...(tracking?.files ?? [])]);
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    async configurePreviewServer(server) {
      // Vite associates .gz with a transport encoding. These are gzip payloads for the volume worker.
      const paths = await readFile(resolve(output, "_headers"), "utf8");
      const gzipPaths = new Set(paths.split("\n").filter(line => line.startsWith("/medical/") && line.endsWith(".gz")));
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split("?")[0];
        if (!gzipPaths.has(path) || !["GET", "HEAD"].includes(request.method)) return next();
        try {
          const file = resolve(output, path.slice(1));
          response.setHeader("Content-Length", (await stat(file)).size);
          response.setHeader("Content-Type", "application/gzip");
          response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (request.method === "HEAD") return response.end();
          const stream = createReadStream(file);
          response.on("close", () => stream.destroy());
          stream.on("error", error => response.destroy(error));
          stream.pipe(response);
        } catch (error) {
          next(error);
        }
      });
    },
    transformIndexHtml() {
      return [
        { tag: "script", attrs: { type: "application/json", id: "medical-assets" },
          children: JSON.stringify({ available: medical.available, models: medical.models,
            assetRelease: medical.release, trackingBase: tracking?.base }), injectTo: "head-prepend" },
        ...(medical.preload ? [{ tag: "script", injectTo: "head-prepend", children: `
          if (typeof DecompressionStream === 'function') {
            const url = new URL(${JSON.stringify("./" + medical.preload)}, document.baseURI).href;
            const controller = new AbortController();
            const response = fetch(url, { signal: controller.signal, priority: 'high' }).catch(() => null);
            globalThis.__neurosliceCtPreview = { url, controller, response };
          }
        ` }] : []),
      ];
    },
    async writeBundle(_, bundle) {
      await Promise.all([...files].map(async ([path, file]) => {
        const dest = resolve(output, path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, file.bytes);
      }));
      const headers = new Map(files);
      for (const path of Object.keys(bundle)) {
        if (!path.startsWith("assets/")) continue;
        const type = path.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
        if (/\.(js|css)$/.test(path)) headers.set(path, { type, immutable: true });
      }
      for (const name of medical.available) {
        const path = "assets/" + name;
        if (headers.has(path)) continue;
        if (/\.(bin|u8|i16le|glb|json)$/.test(name)) {
          const type = name.endsWith(".glb") ? "model/gltf-binary"
            : name.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
          headers.set(path, { type, immutable: false });
        }
      }
      const rules = [...headers].map(([path, file]) => "/" + path + "\n  Content-Type: " + file.type + "\n  Cache-Control: " +
        (file.immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate")).join("\n");
      await appendFile(resolve(output, "_headers"), "\n" + rules + "\n");
      if (tracking.files.size) {
        await Promise.all(["wasm", "models"].map(name => rm(resolve(output, name), { recursive: true, force: true })));
      }
      const worker = resolve(output, "sw.js");
      if (existsSync(worker)) {
        const source = await readFile(worker, "utf8");
        await writeFile(worker, source.replaceAll("__BUILD__", Date.now().toString(36)));
      }
    },
  };
};

// Relative URLs allow the build to be served from a sub-path. Phone mode enables local HTTPS.
export default defineConfig(({ mode }) => {
  const phone = mode === "phone";
  return {
    base: "./",
    appType: "mpa",
    plugins: [staticAssets(), ...(phone ? [basicSsl()] : [])],
    server: phone ? { host: true, port: 5174, strictPort: true } : { port: 5173, strictPort: true },
    preview: { port: 4173 },
    build: { target: "es2022", chunkSizeWarningLimit: 900 },
  };
});

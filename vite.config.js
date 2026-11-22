import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { createReadStream, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { prepareMedicalAssets } from "./scripts/build-medical-assets.mjs";

// Gives the offline cache (public/sw.js) a new name on every build, so a deploy replaces what browsers have stored.
const stampServiceWorker = () => {
  let outDir = "dist";
  return {
    name: "stamp-service-worker",
    apply: "build",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const file = resolve(outDir, "sw.js");
      if (existsSync(file)) writeFileSync(file, readFileSync(file, "utf8").replaceAll("__BUILD__", Date.now().toString(36)));
    }
  };
};

// 发布的影像由 public 数据生成，开发模式直接使用原始文件。
const listMedicalAssets = () => {
  let medicalDir, outputDir, building;
  return {
    name: "list-medical-assets",
    configResolved(config) {
      building = config.command === "build";
      medicalDir = resolve(config.publicDir, "assets");
      outputDir = resolve(config.root, config.build.outDir, "assets");
    },
    async writeBundle() {
      if (existsSync(outputDir)) await prepareMedicalAssets(outputDir);
    },
    configurePreviewServer(server) {
      // Vite treats .gz as Content-Encoding by default. Serve explicit downloads as gzip files.
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const path = request.url?.split("?")[0];
        const match = /^\/assets\/((?:ct_volume\.bin|mri_volume\.bin|volume-preview\.bin|skull\.glb|brain\.glb)\.gz)$/.exec(path);
        if (!match) return next();
        const file = resolve(outputDir, match[1]);
        const info = statSync(file, { throwIfNoEntry: false });
        if (!info?.isFile()) return next();
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", info.size);
        if (request.method === "HEAD") return response.end();
        const stream = createReadStream(file);
        stream.on("error", error => response.destroy(error));
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      });
    },
    transformIndexHtml() {
      const names = [
        "skull.glb", "brain.glb", "meta.json", "ct_volume.bin", "mri_volume.bin",
        "volume.json", "ct.i16le", "mri.u8", "mri_t1.u8", "mri_t2.u8",
      ];
      const available = names.filter(name => existsSync(resolve(medicalDir, name)));
      return [{ tag: "script", attrs: { type: "application/json", id: "medical-assets" },
        children: JSON.stringify(available), injectTo: "head" },
      ...(building && available.includes('meta.json') && available.includes('ct_volume.bin')
        ? [{ tag: "link", attrs: { rel: "preload", as: "fetch", crossorigin: "anonymous",
          href: "./assets/meta.json" }, injectTo: "head" }] : [])];
    }
  };
};

// base "./" keeps every asset path relative, so the built site works from any folder or sub-path.
//
// `npm run dev`        http://localhost:5173, for this computer only.
// `npm run dev:phone`  https on port 5174, reachable from phones on the same Wi-Fi. Phones only allow the
//                      camera on https pages, so this mode serves a self-signed certificate; the phone's
//                      browser shows a warning once, which you accept.
export default defineConfig(({ mode }) => {
  const phone = mode === "phone";
  return {
    base: "./",
    appType: "mpa",
    plugins: [stampServiceWorker(), listMedicalAssets(), ...(phone ? [basicSsl()] : [])],
    server: phone ? { host: true, port: 5174, strictPort: true } : { port: 5173, strictPort: true },
    preview: { port: 4173 },
    build: { target: "es2022", chunkSizeWarningLimit: 900 }
  };
});

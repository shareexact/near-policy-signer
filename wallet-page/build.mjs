// Builds index.html: one self-contained file, the bundle inlined, no CDN.
import { build } from "esbuild";
import fs from "fs";
const r = await build({
  entryPoints: ["src/main.js"], bundle: true, format: "iife", platform: "browser", target: "es2020",
  write: false, minify: true, legalComments: "none", define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: ["src/process-shim.js"], logLevel: "warning",
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const tpl = fs.readFileSync("src/index.template.html", "utf8");
const html = tpl.replace("/*__BUNDLE__*/", () => js);
fs.writeFileSync("index.html", html);
console.log("index.html", html.length, "bytes");

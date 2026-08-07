import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/hero.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: "dist/hero.js",
});

// classic-script build for the self-contained files (modules are blocked on file://)
await build({
  entryPoints: ["src/hero.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  outfile: "dist/hero.iife.js",
});

for (const f of ["index.html", "docs.html", "style.css"]) {
  cpSync(`src/${f}`, `dist/${f}`);
}

// Also emit fully self-contained copies. Opening a lone HTML file means its
// sibling CSS and JS are not there, so these inline everything and work from
// any location, including file://
const css = readFileSync("src/style.css", "utf8");
const js = readFileSync("dist/hero.iife.js", "utf8");

mkdirSync("dist/standalone", { recursive: true });

for (const [file, out] of [["index.html", "tangentfeed-home.html"], ["docs.html", "tangentfeed-docs.html"]]) {
  let html = readFileSync(`src/${file}`, "utf8")
    .replace('<link rel="stylesheet" href="./style.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="./hero.js" type="module"></script>', `<script>\n${js}\n</script>`)
    // keep cross-page links working between the two standalone files
    .replaceAll('"./docs.html', '"./tangentfeed-docs.html')
    .replaceAll('"./index.html', '"./tangentfeed-home.html');
  writeFileSync(`dist/standalone/${out}`, html);
}

console.log("site built → dist/index.html, dist/docs.html");
console.log("standalone → dist/standalone/tangentfeed-home.html, dist/standalone/tangentfeed-docs.html");

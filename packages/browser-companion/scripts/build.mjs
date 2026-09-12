import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import sharp from "sharp";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("static", "dist", { recursive: true });
await cp("../app/assets/images/notification-icon.png", "dist/notification-icon.png");
// Chrome needs PNG action icons; render the vector at each actual toolbar density.
await Promise.all(
  [16, 32, 48, 128].map((size) =>
    sharp("static/icon.svg", { density: 288 })
      .resize(size, size)
      .png()
      .toFile(`dist/icon-${size}.png`),
  ),
);
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
});

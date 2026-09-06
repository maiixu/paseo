import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("static", "dist", { recursive: true });
await cp("../app/assets/images/notification-icon.png", "dist/notification-icon.png");
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
});

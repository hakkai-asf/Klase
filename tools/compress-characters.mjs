import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, prune, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "assets", "characters");
const outDir = path.join(srcDir, "optimized");

/** Compress the playable files from CHARACTERS (deduped). */
const FILES = ["Xbot.skinned.glb"];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "draco3d.encoder": await draco3d.createEncoderModule(),
  });

await mkdir(outDir, { recursive: true });
const available = new Set(await readdir(srcDir));

for (const file of FILES) {
  if (!available.has(file)) {
    console.warn(`[compress] skip missing ${file}`);
    continue;
  }
  const src = path.join(srcDir, file);
  const dest = path.join(outDir, file);
  const document = await io.read(src);
  await document.transform(dedup(), weld(), prune(), draco());
  await io.write(dest, document);
  console.log(`[compress] ${file}`);
}

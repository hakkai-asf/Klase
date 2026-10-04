import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, prune, textureCompress, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "assets", "characters");
const outDir = path.join(srcDir, "optimized");

const FILES = [
  "Xbot.skinned.glb",
  "s.w.a.t_operator_cop_-_game_ready_animated.glb",
  "HAKKAI 3D1.glb",
  "3d_character_young_boy.glb",
  "2pac.glb",
];

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
  await document.transform(dedup(), weld(), prune());
  try {
    await document.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: "webp",
        resize: [1024, 1024],
      }),
    );
  } catch (e) {
    console.warn(`[compress] textures skipped for ${file}:`, e instanceof Error ? e.message : e);
  }
  await document.transform(draco());
  await io.write(dest, document);
  console.log(`[compress] ${file}`);
}

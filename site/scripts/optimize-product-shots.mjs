import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outputRoot = path.resolve(import.meta.dirname, "../public/product-shots");
const files = (await readdir(outputRoot)).filter((file) => file.endsWith(".png"));
const responsiveWidths = [640, 1080, 1200];

for (const file of files) {
  const source = path.join(outputRoot, file);
  const target = path.join(outputRoot, file.replace(/\.png$/i, ".webp"));
  await sharp(source)
    .webp({ quality: 82, effort: 6, smartSubsample: true })
    .toFile(target);

  const [sourceInfo, targetInfo] = await Promise.all([stat(source), stat(target)]);
  if (targetInfo.size >= sourceInfo.size) {
    throw new Error(`Optimized image is not smaller: ${path.basename(target)}`);
  }

  for (const width of responsiveWidths) {
    const responsiveTarget = path.join(
      outputRoot,
      file.replace(/\.png$/i, `-${width}.webp`),
    );
    await sharp(source)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80, effort: 6, smartSubsample: true })
      .toFile(responsiveTarget);

    const responsiveInfo = await stat(responsiveTarget);
    if (responsiveInfo.size >= targetInfo.size) {
      throw new Error(`Responsive image is not smaller: ${path.basename(responsiveTarget)}`);
    }
  }
}

console.log(
  `Optimized ${files.length} product screenshots to WebP with ${responsiveWidths.length} responsive sizes each.`,
);

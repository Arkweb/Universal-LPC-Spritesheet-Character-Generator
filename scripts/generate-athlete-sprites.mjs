/**
 * Generates a small pool of unique "athlete" character sprites (LPC assets,
 * composited through this project's own renderer) for use as top-down match
 * tokens and UI portraits in a third-party sports game (Ultimate Strike -
 * see https://github.com/Arkweb/ultimate-frisbee). Not part of the
 * generator's UI/tests - a standalone script that drives the real app
 * headlessly (same renderCharacter() the UI calls on every selection
 * change) and crops the frames that game actually needs, instead of
 * hand-picking/exporting full spritesheets one at a time through the UI.
 *
 * Usage: node scripts/generate-athlete-sprites.mjs [--out <dir>]
 *
 * Output (under --out, default scripts/_gen/output/):
 *   portraits/athlete_<NN>.png   - 64x40 headshot crop (walk-south frame 0)
 *   tokens/athlete_<NN>_blue.png - 576x64 walk-south cycle strip (9 frames,
 *                                  64px each), blue jersey
 *   tokens/athlete_<NN>_red.png  - same, red jersey
 *   pool.json                   - identity metadata (gender/skin/hair/id)
 *   CREDITS.txt                 - required attribution for every asset used
 *     (LPC licenses require this - see README.md's Licensing section)
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.GEN_PORT || 5190);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const outArgIdx = process.argv.indexOf("--out");
const OUT_DIR =
  outArgIdx !== -1 && process.argv[outArgIdx + 1]
    ? path.resolve(process.argv[outArgIdx + 1])
    : path.join(__dirname, "_gen", "output");

// LPC "universal" layout (tools/layout/universal.json): 64x64 frames, walk
// row for direction "s" (facing camera) is row 10 (0-indexed: 0-3 cast
// n/w/s/e, 4-7 thrust n/w/s/e, 8-11 walk n/w/s/e), 9 frames wide (frame 0 is
// the standing/front pose - used for the portrait crop and as the idle pose
// in-game, see PlayerSprites.gd/FieldUnit.gd).
const FRAME = 64;
const WALK_S_ROW = 10;
const WALK_FRAME_COUNT = 9;
const FRAME_Y = WALK_S_ROW * FRAME;
const PORTRAIT_HEIGHT = 40; // headshot crop: top portion of the 64px frame

// Skin tones, hair styles/colors: plain (non-lpcr) LPC palette entries -
// see the "body"/"hair_*" recolor lists in sheet_definitions. Deliberately
// natural/realistic tones only (this is meant to read as real athletes, not
// a fantasy roster) - kept short and skips the "all.lpcr.*"/"lpcr.*" gradient
// palettes entirely.
const SKIN_TONES = ["light", "amber", "olive", "taupe", "bronze", "brown", "black"];
const HAIR_STYLES = [
  "hair_curly_short",
  "hair_bangsshort",
  "hair_shorthawk",
  "hair_topknot_short",
  "hair_dreadlocks_short",
  "hair_curtains",
];
const HAIR_COLORS = ["black", "dark_brown", "chestnut", "blonde", "red", "gray"];

const POOL_SIZE = Number(process.env.GEN_POOL_SIZE || 24);

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic, evenly-spread pool: alternates gender, cycles the other
 * traits with different step sizes so nearby indices don't repeat the same
 * combination (avoids every other identity looking near-identical). */
function buildPool(size) {
  const rng = mulberry32(20240521);
  const pool = [];
  for (let i = 0; i < size; i++) {
    const gender = i % 2 === 0 ? "male" : "female";
    const skin = SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)];
    const hairStyle = HAIR_STYLES[Math.floor(rng() * HAIR_STYLES.length)];
    const hairColor = HAIR_COLORS[Math.floor(rng() * HAIR_COLORS.length)];
    pool.push({ id: `athlete_${String(i).padStart(2, "0")}`, gender, skin, hairStyle, hairColor });
  }
  return pool;
}

function buildSelections(identity, jerseyColor) {
  const headItemId = identity.gender === "female" ? "heads_human_female" : "heads_human_male";
  return {
    body: { itemId: "body", variant: "", recolor: identity.skin, name: "Body color" },
    head: { itemId: headItemId, variant: "", recolor: identity.skin, name: "Head" },
    expression: { itemId: "face_neutral", variant: "", recolor: identity.skin, name: "Expression" },
    hair: { itemId: identity.hairStyle, variant: "", recolor: identity.hairColor, name: "Hair" },
    clothes: { itemId: "torso_clothes_tshirt", variant: "", recolor: jerseyColor, name: "Jersey" },
    legs: { itemId: "legs_shorts", variant: "", recolor: "black", name: "Shorts" },
    shoes: { itemId: "feet_shoes_basic", variant: "", recolor: "white", name: "Shoes" },
  };
}

function waitForHttpOk(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - start > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
          else setTimeout(tryOnce, 300);
        });
    };
    tryOnce();
  });
}

function dataUrlToBuffer(dataUrl) {
  const b64 = dataUrl.substring(dataUrl.indexOf(",") + 1);
  return Buffer.from(b64, "base64");
}

async function main() {
  mkdirSync(path.join(OUT_DIR, "portraits"), { recursive: true });
  mkdirSync(path.join(OUT_DIR, "tokens"), { recursive: true });

  const pool = buildPool(POOL_SIZE);
  writeFileSync(path.join(OUT_DIR, "pool.json"), JSON.stringify(pool, null, 2));

  const serve = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  serve.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

  let browser;
  try {
    await waitForHttpOk(BASE_URL + "/", 30000);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.GEN_CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on("pageerror", (e) => console.error("PAGE ERROR:", String(e)));

    await page.goto(BASE_URL + "/", { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.canvasRenderer, undefined, { timeout: 30000 });
    await page.evaluate(async () => {
      const catalogMod = await import("/sources/state/catalog.ts");
      const c = catalogMod.defaultCatalog;
      const start = Date.now();
      while (
        !(c.isIndexReady() && c.isLiteReady() && c.isCreditsReady() && c.isLayersReady()) &&
        Date.now() - start < 60000
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    const allCreditsAccum = [];

    for (const identity of pool) {
      // Portrait + blue-jersey match token share one render (see FRAME_Y
      // crop below); red-jersey token is a second render (only the jersey
      // recolor differs).
      for (const jersey of ["blue", "red"]) {
        const selections = buildSelections(identity, jersey);
        const result = await page.evaluate(
          async ({ selections, bodyType, frameY, frameSize, frameCount, portraitHeight }) => {
            const renderer = window.canvasRenderer;
            await renderer.renderCharacter(selections, bodyType);
            const src = renderer.canvas;

            function cropToDataUrl(sx, sy, sw, sh) {
              const c = document.createElement("canvas");
              c.width = sw;
              c.height = sh;
              const ctx = c.getContext("2d");
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
              return c.toDataURL("image/png");
            }

            // Full walk-south cycle strip (frameCount frames side by side,
            // left to right in animation order) - Godot slices this into
            // individual frames at runtime (see PlayerSprites.gd).
            const tokenDataUrl = cropToDataUrl(0, frameY, frameSize * frameCount, frameSize);
            const portraitDataUrl = cropToDataUrl(0, frameY, frameSize, portraitHeight);

            const jsonMod = await import("/sources/state/json.ts");
            const creditsMod = await import("/sources/utils/credits.ts");
            const catalogMod = await import("/sources/state/catalog.ts");
            const credits = creditsMod.getAllCredits(catalogMod.defaultCatalog, selections, bodyType);
            void jsonMod;
            return { tokenDataUrl, portraitDataUrl, credits };
          },
          {
            selections,
            bodyType: identity.gender,
            frameY: FRAME_Y,
            frameSize: FRAME,
            frameCount: WALK_FRAME_COUNT,
            portraitHeight: PORTRAIT_HEIGHT,
          },
        );

        writeFileSync(
          path.join(OUT_DIR, "tokens", `${identity.id}_${jersey}.png`),
          dataUrlToBuffer(result.tokenDataUrl),
        );
        if (jersey === "blue") {
          writeFileSync(
            path.join(OUT_DIR, "portraits", `${identity.id}.png`),
            dataUrlToBuffer(result.portraitDataUrl),
          );
        }
        allCreditsAccum.push(...result.credits);
        process.stdout.write(`generated ${identity.id} (${jersey})\n`);
      }
    }

    const seen = new Set();
    const dedupedLines = [];
    for (const c of allCreditsAccum) {
      const key = JSON.stringify([c.file, c.authors, c.licenses, c.urls]);
      if (seen.has(key)) continue;
      seen.add(key);
      const authors = (c.authors || []).join(", ");
      const licenses = (c.licenses || []).join(", ");
      const urls = (c.urls || []).join(", ");
      dedupedLines.push(`${c.file} - ${authors} - ${licenses} - ${urls}`);
    }
    const creditsHeader =
      "Sprites generated with the Universal LPC Spritesheet Character Generator\n" +
      "(https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).\n" +
      "Per-asset attribution below is required by several of these licenses (CC-BY,\n" +
      "CC-BY-SA, OGA-BY) - see that project's README.md 'Licensing and Attribution'\n" +
      "section for full terms.\n\n";
    writeFileSync(path.join(OUT_DIR, "CREDITS.txt"), creditsHeader + dedupedLines.sort().join("\n") + "\n");

    console.log(`\nDone. ${pool.length} identities x 2 jerseys in ${OUT_DIR}`);
  } finally {
    if (browser) await browser.close();
    serve.kill();
  }
}

await main();

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
 *   portraits/athlete_<NN>.png                    - 64x40 headshot crop
 *                                                    (walk-south frame 0)
 *   tokens/athlete_<NN>_{blue,red}_<anim>_{n,s,w}.png
 *     - one cycle strip per (identity x jersey x animation x direction),
 *       frame count depends on <anim> (see ANIMATIONS) - "e" is
 *       deliberately not rendered for any animation, the game mirrors "w"
 *       for that instead (see ultimate-frisbee/scripts/data/
 *       PlayerSprites.gd) since a symmetric humanoid's east/west art is a
 *       pure horizontal flip of itself in this asset library.
 *   pool.json                                     - identity metadata
 *                                                    (gender/skin/hair/id)
 *   CREDITS.txt   - required attribution for every asset used (LPC
 *     licenses require this - see README.md's Licensing section)
 *
 * One renderCharacter() call per (identity, jersey) still produces the
 * *entire* composited sheet (renderer.canvas is sized to the full
 * "universal-expanded" layout - see sources/canvas/renderer.ts's
 * SHEET_HEIGHT, 3456px = 54 rows - regardless of which single animation
 * the UI happens to be previewing), so adding more animations here is just
 * more (cheap, client-side) crops per render, not more renders.
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

// LPC "universal-expanded" layout (tools/layout/universal-expanded.json,
// the one the app's renderer actually composites onto its canvas - see
// SHEET_HEIGHT): 64x64 frames, row index and frame count per animation
// below (n/w/s only per animation, "e" mirrored - see class doc comment).
// Confirmed directly from that layout file rather than assumed - row
// numbers for cast/thrust/walk/slash/shoot/hurt match the older, shorter
// "universal" layout exactly (this is a superset, not a renumbering).
const FRAME = 64;
const ANIMATIONS = {
  // The movement cycle actually used while a unit is running around the
  // field (see FieldUnit.gd/AiUnit.gd) - "run", not the slower "walk",
  // matches the pace of a real Ultimate point better; walk is still
  // generated too since it's the base idle-frame-0 fallback in a couple of
  // UI-only spots (portraits) and cheap to keep.
  walk: { rows: { n: 8, w: 9, s: 10 }, frameCount: 9 },
  run: { rows: { n: 38, w: 39, s: 40 }, frameCount: 8 },
  // Throw flourish - alternates with backslash in-game (see FieldUnit.gd)
  // rather than the sword-swing connotation mattering; LPC just calls its
  // two one-handed swing animations "slash"/"backslash".
  slash: { rows: { n: 12, w: 13, s: 14 }, frameCount: 6 },
  backslash: { rows: { n: 46, w: 47, s: 48 }, frameCount: 13 },
  thrust: { rows: { n: 4, w: 5, s: 6 }, frameCount: 8 }, // reception flourish
  jump: { rows: { n: 26, w: 27, s: 28 }, frameCount: 5 }, // interception flourish
  combat_idle: { rows: { n: 42, w: 43, s: 44 }, frameCount: 2 }, // standing-still pose
};
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
      // Portrait + blue-jersey match tokens share one render (see the
      // per-direction crops below, all read from the same canvas);
      // red-jersey tokens are a second render (only the jersey recolor
      // differs).
      for (const jersey of ["blue", "red"]) {
        const selections = buildSelections(identity, jersey);
        const result = await page.evaluate(
          async ({ selections, bodyType, animations, frameSize, portraitHeight }) => {
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

            // One full cycle strip per (animation x real direction) -
            // frameCount frames side by side, left to right in animation
            // order - Godot slices each into individual frames at runtime
            // (see PlayerSprites.gd). Portrait stays walk-south frame 0
            // regardless of jersey/animation/direction loop.
            const tokenDataUrls = {};
            for (const [anim, { rows, frameCount }] of Object.entries(animations)) {
              for (const [dir, row] of Object.entries(rows)) {
                tokenDataUrls[`${anim}_${dir}`] = cropToDataUrl(0, row * frameSize, frameSize * frameCount, frameSize);
              }
            }
            const portraitDataUrl = cropToDataUrl(0, animations.walk.rows.s * frameSize, frameSize, portraitHeight);

            const jsonMod = await import("/sources/state/json.ts");
            const creditsMod = await import("/sources/utils/credits.ts");
            const catalogMod = await import("/sources/state/catalog.ts");
            const credits = creditsMod.getAllCredits(catalogMod.defaultCatalog, selections, bodyType);
            void jsonMod;
            return { tokenDataUrls, portraitDataUrl, credits };
          },
          {
            selections,
            bodyType: identity.gender,
            animations: ANIMATIONS,
            frameSize: FRAME,
            portraitHeight: PORTRAIT_HEIGHT,
          },
        );

        for (const [animDir, dataUrl] of Object.entries(result.tokenDataUrls)) {
          writeFileSync(
            path.join(OUT_DIR, "tokens", `${identity.id}_${jersey}_${animDir}.png`),
            dataUrlToBuffer(dataUrl),
          );
        }
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

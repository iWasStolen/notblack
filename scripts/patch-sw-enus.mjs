/* Patch the vendored Scramjet v2 service-worker bundle so every
   proxied request carries Accept-Language: en-US,en;q=0.9 instead
   of the visitor's browser locale.

   Why here: controller.sw.js is where the intercepted request's
   headers ([...e.request.headers] → pairs of [name, value]) are
   handed to the page-side controller via RPC (`initialHeaders`).
   Overriding the accept-language pair at this single choke point
   covers document navigations AND sub-resource fetches for every
   proxied site (Google, YouTube, Wikipedia…).

   The patch is a pure expression swap — no API/shape change, so the
   version-lock between scramjet.js core and controller.api.js is
   untouched. Idempotent: running it twice changes nothing. */

import { readFileSync, writeFileSync } from "node:fs";

const SW = new URL("../public/controller/controller.sw.js", import.meta.url);
const WRAPPER = new URL("../public/sw.js", import.meta.url);

const NEEDLE = "initialHeaders:s";
/* filter out any existing accept-language pair, then append exactly
   one forced en-US pair — covers requests that omit the header too */
const PATCHED = 'initialHeaders:s.filter(' +
  'e=>"accept-language"!==e[0].toLowerCase())' +
  '.concat([["accept-language","en-US,en;q=0.9"]])';

let src = readFileSync(SW, "utf8");
if (src.includes("en-US,en;q=0.9")) {
  console.log("controller.sw.js: already patched — nothing to do");
} else {
  const count = src.split(NEEDLE).length - 1;
  if (count !== 1) {
    throw new Error(
      `expected exactly 1 occurrence of ${JSON.stringify(NEEDLE)}, found ${count} — ` +
      "the vendored bundle changed; patch manually."
    );
  }
  src = src.replace(NEEDLE, PATCHED);
  writeFileSync(SW, src);
  console.log("controller.sw.js: patched initialHeaders → forced en-US accept-language");
}

/* Bump our sw.js wrapper (comment-only byte change) so browsers that
   already installed the service worker re-run the update check and
   pull the patched controller.sw.js via importScripts. */
const PATCH_TAG = "/* patch: en-US accept-language (2026-10-30) */";
let wrap = readFileSync(WRAPPER, "utf8");
if (!wrap.includes(PATCH_TAG)) {
  wrap = PATCH_TAG + "\n" + wrap;
  writeFileSync(WRAPPER, wrap);
  console.log("sw.js: wrapper byte-bumped for SW update rollout");
} else {
  console.log("sw.js: wrapper already bumped");
}

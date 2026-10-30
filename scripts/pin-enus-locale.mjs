/* Codemod: pin every locale-sensitive format call to en-US so the
   UI renders US English regardless of the visitor's browser locale.

   Patterns (applied only to the files listed below — shadcn ui/
   primitives included, they are vendored into this repo):
     .toLocaleString()                  → .toLocaleString("en-US")
     .toLocaleDateString()              → .toLocaleDateString("en-US")
     .toLocaleTimeString()              → .toLocaleTimeString("en-US")
     .toLocaleTimeString([], {          → .toLocaleTimeString("en-US", {
     .toLocaleString("default", {       → .toLocaleString("en-US", {
     x.localeCompare(y)                 → x.localeCompare(y, "en-US")
     localeCompare(y, undefined, {      → localeCompare(y, "en-US", {
   Idempotent: a second run finds nothing to change. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "src/lib/ai-files.ts",
  "src/components/apps/text-tools.tsx",
  "src/components/apps/notes.tsx",
  "src/components/views/browse-view.tsx",
  "src/components/views/play-view.tsx",
  "src/components/views/chat-panels.tsx",
  "src/components/views/chat-view.tsx",
  "src/components/views/ai-view.tsx",
  "src/components/games/player.tsx",
  "src/components/games/builtin/shared.tsx",
  "src/components/games/builtin/breakout.tsx",
  "src/components/games/builtin/asteroids.tsx",
  "src/components/games/builtin/game-2048.tsx",
  "src/components/games/builtin/tetris.tsx",
  "src/components/ui/calendar.tsx",
  "src/components/ui/chart.tsx",
  "src/app/api/games/route.ts",
];

const RULES = [
  [".toLocaleString()", '.toLocaleString("en-US")'],
  [".toLocaleDateString()", '.toLocaleDateString("en-US")'],
  [".toLocaleTimeString()", '.toLocaleTimeString("en-US")'],
  [".toLocaleTimeString([], {", '.toLocaleTimeString("en-US", {'],
  ['.toLocaleString("default", {', '.toLocaleString("en-US", {'],
  ["a.localeCompare(b)", 'a.localeCompare(b, "en-US")'],
  ["a.name.localeCompare(b.name)", 'a.name.localeCompare(b.name, "en-US")'],
  ["b.name.localeCompare(a.name)", 'b.name.localeCompare(a.name, "en-US")'],
  ["localeCompare(b.entryName, undefined, {", 'localeCompare(b.entryName, "en-US", {'],
];

let total = 0;
for (const rel of FILES) {
  const path = join(root, rel);
  let src = readFileSync(path, "utf8");
  const before = src;
  for (const [from, to] of RULES) {
    src = src.split(from).join(to);
  }
  if (src !== before) {
    const n = RULES.reduce(
      (acc, [from]) => acc + (before.split(from).length - 1), 0
    );
    total += n;
    writeFileSync(path, src);
    console.log(`${rel}: ${n} replacement(s)`);
  }
}
console.log(`\n${total} replacement(s) across ${FILES.length} files`);

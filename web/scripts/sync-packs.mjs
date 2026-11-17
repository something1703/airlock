// Copies the shared pattern packs (source of truth: the Swift package resources) into the web engine.
// `npm test` fails if they drift (tests/packs.test.ts). Run after editing a pack.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const from = join(root, "Packages/AirlockKit/Sources/AirlockDetect/PatternPacks");
const to = join(root, "web/src/engine/packs");
mkdirSync(to, { recursive: true });
for (const f of ["core.json", "national.json"]) copyFileSync(join(from, f), join(to, f));

// Prompts: the Swift package resources are the source of truth (docs/04-PROMPTS.md).
const promptsFrom = join(root, "Packages/AirlockKit/Sources/AirlockPrompts/Prompts");
const promptsTo = join(root, "web/src/engine/prompts");
mkdirSync(promptsTo, { recursive: true });
for (const f of readdirSync(promptsFrom).filter((n) => n.endsWith(".txt"))) copyFileSync(join(promptsFrom, f), join(promptsTo, f));
console.log("pattern packs and prompts synced");

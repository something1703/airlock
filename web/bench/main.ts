// Entry point: `npm run bench -- <command>` (vite-node, so the engine's bundled prompts load as in the app).
import { main } from "./cli";

process.exitCode = await main(process.argv.slice(2));

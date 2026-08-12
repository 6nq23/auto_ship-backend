// Explicit /api entrypoint for vercel.json. The same handler is also exported
// directly by src/app.ts for Vercel's automatic Express app detection.
export { default } from "../src/app.js";

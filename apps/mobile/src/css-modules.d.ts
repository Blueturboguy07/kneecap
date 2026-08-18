// Vite handles .css imports at build time; this keeps tsc --noEmit quiet
// about them (same pattern as the other app shells' ambient declarations).
declare module "*.css";

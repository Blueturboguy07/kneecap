// Headless bookmark logic only.
//
// kneecap M2: this barrel is consumed by `EditorCore` (scenes-manager) and by
// `commands/scene/*`, all of which live in the headless `@kneecap/editor-core`
// package. Re-exporting a React component or hook from here drags the whole UI
// tree — `components/ui/*`, `actions/keybindings-store` (zustand), `react` —
// into the engine's import closure. It used to.
//
// The React surface now lives in `./ui.ts`; import it from app/UI code only.
export {
	findBookmarkIndex,
	isBookmarkAtTime,
	toggleBookmarkInArray,
	removeBookmarkFromArray,
	updateBookmarkInArray,
	moveBookmarkInArray,
	getFrameTime,
	getBookmarkAtTime,
	getBookmarksActiveAtTime,
} from "./utils";
export { getBookmarkSnapPoints } from "./snap-source";

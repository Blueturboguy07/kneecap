import { buildEdl, serializeEdl } from "../src/edl";
import {
  buildFixtureMediaAssets, buildFixtureProject, buildFixtureScene,
  fixtureAssetResolver, FIXTURE_OUTPUT,
} from "../src/edl/__tests__/fixture";
const edl = buildEdl({
  project: buildFixtureProject(),
  scene: buildFixtureScene(),
  mediaAssets: buildFixtureMediaAssets(),
  output: FIXTURE_OUTPUT,
  resolveAsset: fixtureAssetResolver,
});
await Bun.write(
  new URL("../src/edl/__tests__/golden-edl-v1.json", import.meta.url).pathname,
  serializeEdl({ edl }) + "\n",
);
console.log("wrote golden fixture");

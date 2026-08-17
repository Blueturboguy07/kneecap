package dev.kneecap.app.edl

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `EdlParser` against a hand-authored JSON document shaped exactly like
 * `packages/editor-core/src/edl/__tests__/golden-edl-v1.json` (the TS-side
 * golden fixture) — not byte-identical to it (this test predates that file
 * being wired as a cross-language fixture; see M9 handoff for the
 * follow-up), but every field name/type/nesting matches `types.ts`
 * (`Edl.kt`'s doc comment). Deliberately includes a two-clip crossfade
 * transition and a text overlay — the exact shape M1's "hand-written 2-clip
 * + cross-fade + text-overlay EDL" spike test describes — because that is
 * the construct `EdlToComposition` treats specially.
 *
 * Runs as a plain JVM unit test — `org.json` is a real (non-stubbed)
 * implementation on Android's unit-test classpath by default (confirmed by
 * this test actually passing, not by assumption); no Robolectric, no
 * `testOptions.unitTests.returnDefaultValues`, matching M4's "pure JVM,
 * framework-free where possible" precedent (`MediaMathTest`).
 */
class EdlParserTest {
    private fun sampleEdlJson(): JSONObject = JSONObject(
        """
        {
          "meta": {
            "edlVersion": 1,
            "generator": "kneecap-test",
            "ticksPerSecond": 120000,
            "frameRate": { "numerator": 30000, "denominator": 1001 },
            "canvas": { "width": 1080, "height": 1920 },
            "projectId": "proj-1",
            "projectName": "Test Project",
            "sceneId": "scene-1",
            "sceneName": "Scene 1",
            "durationTicks": 480000
          },
          "assets": [
            {
              "assetId": "asset-1",
              "kind": "video",
              "name": "a.mp4",
              "sourceUri": "kneecap-media://sandbox/asset-1",
              "codec": "avc1.640028",
              "width": 1080,
              "height": 1920,
              "durationTicks": 720000,
              "rotationDegrees": 0,
              "hasAudio": true
            }
          ],
          "tracks": [
            {
              "trackId": "track-main",
              "kind": "main",
              "trackType": "video",
              "name": "Main",
              "zIndex": 0,
              "muted": false,
              "hidden": false,
              "clips": [
                {
                  "clipId": "clip-a",
                  "kind": "video",
                  "assetId": "asset-1",
                  "name": "a.mp4",
                  "startTicks": 0,
                  "durationTicks": 240000,
                  "sourceStartTicks": 0,
                  "sourceEndTicks": 240000,
                  "trimEndTicks": 0,
                  "speed": { "numerator": 1, "denominator": 1 },
                  "maintainPitch": false,
                  "volumeDb": 0,
                  "muted": false,
                  "hidden": false,
                  "transform": { "positionX": 0, "positionY": 0, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0 },
                  "opacity": 1,
                  "blendMode": "normal",
                  "effects": [],
                  "masks": [],
                  "animations": [],
                  "params": {}
                },
                {
                  "clipId": "clip-b",
                  "kind": "video",
                  "assetId": "asset-1",
                  "name": "a.mp4",
                  "startTicks": 240000,
                  "durationTicks": 240000,
                  "sourceStartTicks": 240000,
                  "sourceEndTicks": 480000,
                  "trimEndTicks": 0,
                  "speed": { "numerator": 1, "denominator": 1 },
                  "maintainPitch": false,
                  "volumeDb": 0,
                  "muted": false,
                  "hidden": false,
                  "transform": { "positionX": 0, "positionY": 0, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0 },
                  "opacity": 1,
                  "blendMode": "normal",
                  "effects": [],
                  "masks": [],
                  "animations": [],
                  "params": {}
                }
              ]
            },
            {
              "trackId": "track-text",
              "kind": "overlay",
              "trackType": "text",
              "name": "Text",
              "zIndex": 1,
              "muted": false,
              "hidden": false,
              "clips": [
                {
                  "clipId": "clip-title",
                  "kind": "text",
                  "assetId": null,
                  "name": "Title",
                  "startTicks": 0,
                  "durationTicks": 120000,
                  "sourceStartTicks": 0,
                  "sourceEndTicks": 0,
                  "trimEndTicks": 0,
                  "speed": { "numerator": 1, "denominator": 1 },
                  "maintainPitch": false,
                  "volumeDb": 0,
                  "muted": false,
                  "hidden": false,
                  "transform": { "positionX": 0, "positionY": -200, "scaleX": 1, "scaleY": 1, "rotateDegrees": 0 },
                  "opacity": 1,
                  "blendMode": "normal",
                  "effects": [],
                  "masks": [],
                  "animations": [],
                  "params": { "content": "kneecap", "fontSize": 72, "color": "#00CAE0" }
                }
              ]
            }
          ],
          "transitions": [
            { "transitionId": "t-1", "afterClipId": "clip-a", "kind": "crossfade", "durationTicks": 24000 }
          ],
          "overlays": [
            { "overlayId": "o-1", "kind": "text", "trackId": "track-text", "clipId": "clip-title", "zIndex": 0, "startTicks": 0, "durationTicks": 120000 }
          ],
          "output": {
            "container": "mp4",
            "videoCodec": "avc1",
            "audioCodec": "mp4a",
            "bitrate": 8000000,
            "fps": { "numerator": 30000, "denominator": 1001 },
            "resolution": { "width": 1080, "height": 1920 },
            "includeAudio": true
          }
        }
        """.trimIndent(),
    )

    @Test
    fun `parses meta with exact rational frame rate, never a rounded float`() {
        val edl = EdlParser.parse(sampleEdlJson())
        assertEquals(1, edl.meta.edlVersion)
        assertEquals(120000L, edl.meta.ticksPerSecond)
        assertEquals(30000L, edl.meta.frameRate.numerator)
        assertEquals(1001L, edl.meta.frameRate.denominator)
        assertEquals(480000L, edl.meta.durationTicks)
    }

    @Test
    fun `parses assets with a non-null sourceUri`() {
        val edl = EdlParser.parse(sampleEdlJson())
        assertEquals(1, edl.assets.size)
        assertEquals("kneecap-media://sandbox/asset-1", edl.assets[0].sourceUri)
        assertEquals(EdlAssetKind.VIDEO, edl.assets[0].kind)
    }

    @Test
    fun `identifies exactly one main track with two ordered clips`() {
        val edl = EdlParser.parse(sampleEdlJson())
        val main = edl.mainTrack()
        assertTrue(main != null)
        assertEquals(2, main!!.clips.size)
        assertEquals("clip-a", main.clips[0].clipId)
        assertEquals("clip-b", main.clips[1].clipId)
    }

    @Test
    fun `parses the crossfade transition`() {
        val edl = EdlParser.parse(sampleEdlJson())
        assertEquals(1, edl.transitions.size)
        assertEquals("clip-a", edl.transitions[0].afterClipId)
        assertEquals("crossfade", edl.transitions[0].kind)
        assertEquals(24000L, edl.transitions[0].durationTicks)
    }

    @Test
    fun `parses the text overlay and its clip's text params`() {
        val edl = EdlParser.parse(sampleEdlJson())
        assertEquals(1, edl.overlays.size)
        assertEquals(EdlOverlayKind.TEXT, edl.overlays[0].kind)
        val textTrack = edl.tracks.first { it.trackId == "track-text" }
        val clip = textTrack.clips.first { it.clipId == "clip-title" }
        assertEquals("kneecap", clip.params["content"])
        assertEquals("#00CAE0", clip.params["color"])
        assertNull(clip.assetId)
    }

    @Test
    fun `throws EdlParseException on a missing required field, not a bare JSONException`() {
        val broken = sampleEdlJson()
        broken.getJSONObject("meta").remove("ticksPerSecond")
        assertThrows(EdlParseException::class.java) { EdlParser.parse(broken) }
    }

    @Test
    fun `throws EdlParseException on an unknown enum-shaped string`() {
        val broken = sampleEdlJson()
        broken.getJSONArray("assets").getJSONObject(0).put("kind", "not-a-real-kind")
        assertThrows(EdlParseException::class.java) { EdlParser.parse(broken) }
    }

    @Test
    fun `masks and animations are detected as presence flags, not fully parsed`() {
        val withMask = sampleEdlJson()
        val clip = withMask.getJSONArray("tracks").getJSONObject(0).getJSONArray("clips").getJSONObject(0)
        clip.put("masks", org.json.JSONArray().put(JSONObject().put("maskId", "m1").put("type", "blur").put("params", JSONObject())))
        val edl = EdlParser.parse(withMask)
        assertTrue(edl.mainTrack()!!.clips[0].hasMasks)
        assertTrue(!edl.mainTrack()!!.clips[1].hasMasks)
    }
}

import { test } from "node:test";
import assert from "node:assert/strict";

import { getPlatformConfigGuide } from "../src/platform.ts";

test("getPlatformConfigGuide macOS", () => {
  const guide = getPlatformConfigGuide({
    relayUrl: "ws://127.0.0.1:18899/ws",
    derivedOrigin: "http://127.0.0.1:18899",
    port: 18899,
    platform: "darwin",
  });

  assert.equal(guide.osName, "macOS");
  assert.ok(guide.portCheckCommand.includes("lsof"));
  assert.ok(guide.configExample.includes("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:18899/ws"));
  assert.ok(guide.configExample.includes("open -a \"/Applications/ZCode.app\""));
  assert.ok(guide.launchExample.includes("/Applications/ZCode.app/Contents/MacOS/ZCode"));
});

test("getPlatformConfigGuide Linux", () => {
  const guide = getPlatformConfigGuide({
    relayUrl: "ws://127.0.0.1:18899/ws",
    derivedOrigin: "http://127.0.0.1:18899",
    port: 18899,
    platform: "linux",
  });

  assert.equal(guide.osName, "Linux");
  assert.ok(guide.portCheckCommand.includes("ss -tlnp"));
  assert.ok(guide.configInstruction.includes("zcode.desktop"));
  assert.ok(guide.configExample.includes("/opt/ZCode/zcode %U"));
  assert.ok(guide.launchExample.includes("/opt/ZCode/zcode"));
});

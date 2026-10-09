import { assert, assertEquals } from "@std/assert";

import { getPlatformConfigGuide } from "../src/platform.ts";

Deno.test("getPlatformConfigGuide macOS", () => {
  const guide = getPlatformConfigGuide({
    relayUrl: "ws://127.0.0.1:18899/ws",
    derivedOrigin: "http://127.0.0.1:18899",
    port: 18899,
    platform: "darwin",
  });

  assertEquals(guide.osName, "macOS");
  assert(guide.portCheckCommand.includes("lsof"));
  assert(
    guide.configExample.includes(
      "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://127.0.0.1:18899/ws",
    ),
  );
  assert(guide.configExample.includes('open -a "/Applications/ZCode.app"'));
  assert(guide.launchExample.includes("/Applications/ZCode.app/Contents/MacOS/ZCode"));
});

Deno.test("getPlatformConfigGuide Linux", () => {
  const guide = getPlatformConfigGuide({
    relayUrl: "ws://127.0.0.1:18899/ws",
    derivedOrigin: "http://127.0.0.1:18899",
    port: 18899,
    platform: "linux",
  });

  assertEquals(guide.osName, "Linux");
  assert(guide.portCheckCommand.includes("ss -tlnp"));
  assert(guide.configInstruction.includes("zcode.desktop"));
  assert(guide.configExample.includes("/opt/ZCode/zcode %U"));
  assert(guide.launchExample.includes("/opt/ZCode/zcode"));
});

Deno.test("未显式传平台时按 Deno.build.os 推导", () => {
  const guide = getPlatformConfigGuide({
    relayUrl: "ws://127.0.0.1:18899/ws",
    derivedOrigin: "http://127.0.0.1:18899",
    port: 18899,
  });
  assertEquals(guide.osName, Deno.build.os === "darwin" ? "macOS" : "Linux");
});

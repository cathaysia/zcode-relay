/**
 * 平台辅助函数：根据当前操作系统提供适配的命令与提示信息。
 */

export interface PlatformConfigGuide {
  osName: string;
  configInstruction: string;
  configExample: string;
  launchExample: string;
  portCheckCommand: string;
}

export function getPlatformConfigGuide(options: {
  relayUrl: string;
  derivedOrigin: string;
  port: number;
  /** 默认取 `Deno.build.os`；显式传入便于测试。 */
  platform?: string;
}): PlatformConfigGuide {
  const os = options.platform ?? Deno.build.os;
  const isMac = os === "darwin";

  if (isMac) {
    return {
      osName: "macOS",
      configInstruction: "macOS 终端运行（或写入 ~/.zshrc / 使用 launchctl 环境变量）：",
      configExample: [
        `  export ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${options.relayUrl}`,
        `  export ZCODE_WEB_REMOTE_CONTROL_URL=${options.derivedOrigin}/remote/v4`,
        '  open -a "/Applications/ZCode.app"',
      ].join("\n"),
      launchExample: [
        `  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${options.relayUrl} \\`,
        `  ZCODE_WEB_REMOTE_CONTROL_URL=${options.derivedOrigin}/remote/v4 \\`,
        "  /Applications/ZCode.app/Contents/MacOS/ZCode",
      ].join("\n"),
      portCheckCommand: `lsof -iTCP:${options.port} -sTCP:LISTEN`,
    };
  }

  return {
    osName: "Linux",
    configInstruction: "编辑 ~/.local/share/applications/zcode.desktop，把 Exec 改为：",
    configExample: [
      "  Exec=env \\",
      `    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${options.relayUrl} \\`,
      `    ZCODE_WEB_REMOTE_CONTROL_URL=${options.derivedOrigin}/remote/v4 \\`,
      "    /opt/ZCode/zcode %U",
    ].join("\n"),
    launchExample: [
      `  ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=${options.relayUrl} \\`,
      "    /opt/ZCode/zcode",
    ].join("\n"),
    portCheckCommand: `ss -tlnp | grep ${options.port}`,
  };
}

/**
 * Mnemo wire-protocol — single source of truth for all client SDKs.
 *
 * Defined in TypeBox so it generates JSON Schema for the Node side AND
 * codegen targets (Swift / Kotlin / Go / Rust) for the upcoming
 * mnemo-pc-agent + Mnemo Remote mobile apps.
 *
 * Keep this file dependency-free except for @sinclair/typebox so the
 * codegen step has a clean surface to consume.
 *
 * Run:
 *   node protocol/codegen.js   →  emits protocol/dist/{schema.json, swift, kotlin, go}
 */

import { Type, Static } from "@sinclair/typebox";

// --------------------------------------------------------------------------
// Pairing / handshake
// --------------------------------------------------------------------------
export const PairingRequest = Type.Object({
  device_kind: Type.Union([Type.Literal("pc"), Type.Literal("mobile")]),
  os: Type.String(),                                         // "windows" | "macos" | "linux" | "ios" | "android"
  device_name: Type.String(),                                // user-friendly name ("Mayk MBP")
  fingerprint: Type.String(),                                // sha256(public_key)
  pairing_code: Type.String(),                               // 6-digit code shown by dispatcher
});
export type PairingRequest = Static<typeof PairingRequest>;

export const PairingAck = Type.Object({
  device_id: Type.String(),                                  // assigned by dispatcher
  jwt: Type.String(),                                        // session token
  ws_url: Type.String(),                                     // WSS endpoint to connect to
});
export type PairingAck = Static<typeof PairingAck>;

// --------------------------------------------------------------------------
// Frame envelope (every WSS message)
// --------------------------------------------------------------------------
export const Frame = Type.Object({
  v: Type.Number({ default: 1 }),                            // protocol version
  id: Type.String(),                                         // request id (uuid)
  ts: Type.String(),                                         // ISO8601 timestamp
  kind: Type.Union([
    Type.Literal("rpc.request"),
    Type.Literal("rpc.response"),
    Type.Literal("rpc.error"),
    Type.Literal("event"),
    Type.Literal("heartbeat"),
  ]),
  method: Type.Optional(Type.String()),                      // for rpc.request: tool name
  args: Type.Optional(Type.Any()),                           // for rpc.request: tool args
  result: Type.Optional(Type.Any()),                         // for rpc.response
  error: Type.Optional(Type.Object({                         // for rpc.error
    code: Type.Number(),
    message: Type.String(),
    data: Type.Optional(Type.Any()),
  })),
  event: Type.Optional(Type.String()),                       // for events: event-type
  payload: Type.Optional(Type.Any()),                        // for events: payload
});
export type Frame = Static<typeof Frame>;

// --------------------------------------------------------------------------
// RPC tools the device-agent exposes (PC + Mobile)
// --------------------------------------------------------------------------
export const ScreenshotArgs = Type.Object({
  region: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() })),
});
export const ScreenshotResult = Type.Object({
  png_base64: Type.String(),
  width: Type.Number(),
  height: Type.Number(),
});

export const TapArgs = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  modifiers: Type.Optional(Type.Array(Type.String())),       // ["ctrl", "shift", "cmd"]
});

export const TypeTextArgs = Type.Object({
  text: Type.String(),
  rate_chars_per_sec: Type.Optional(Type.Number({ default: 80 })),
});

export const KeyPressArgs = Type.Object({
  key: Type.String(),                                        // "enter" | "tab" | "esc" | "f5" | "a" ...
  modifiers: Type.Optional(Type.Array(Type.String())),
});

export const FileReadArgs = Type.Object({
  path: Type.String(),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
});
export const FileWriteArgs = Type.Object({
  path: Type.String(),
  content: Type.String(),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
  confirm: Type.Optional(Type.Boolean({ default: false })),  // require owner confirmation push
});

export const ShellExecArgs = Type.Object({
  cmd: Type.String(),
  cwd: Type.Optional(Type.String()),
  timeout_sec: Type.Optional(Type.Number({ default: 30 })),
  confirm: Type.Optional(Type.Boolean({ default: false })),
});

export const AppOpenArgs = Type.Object({
  app: Type.String(),                                        // "WhatsApp" | "Chrome" | "VSCode" | bundle-id on iOS
  args: Type.Optional(Type.Array(Type.String())),
});

export const CallPhoneArgs = Type.Object({
  number: Type.String(),                                     // e.g. "+43..."
  voice_agent: Type.Optional(Type.String()),                 // optional voice-agent profile name
  confirm: Type.Optional(Type.Boolean({ default: true })),
});

export const Tools = {
  screenshot: { args: ScreenshotArgs, result: ScreenshotResult },
  tap_at: { args: TapArgs },
  type_text: { args: TypeTextArgs },
  key_press: { args: KeyPressArgs },
  file_read: { args: FileReadArgs },
  file_write: { args: FileWriteArgs },
  shell_exec: { args: ShellExecArgs },
  app_open: { args: AppOpenArgs },
  call_phone: { args: CallPhoneArgs },
};

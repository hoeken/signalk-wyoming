/**
 * Wyoming protocol implementation (subpath export `signalk-wyoming/protocol`).
 *
 * Zero runtime dependencies; no Signal K imports. Usable standalone by the
 * signalk-piper / signalk-whisper / signalk-openwakeword plugins' test suites
 * and by anything else that needs to speak Wyoming from Node.
 */

export * from "./events.js";
export * from "./framing.js";
export * from "./client.js";

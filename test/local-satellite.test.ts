import { describe, expect, it } from "vitest";
import { DEFAULT_ADVANCED, DEFAULT_LOCAL_SATELLITE } from "../src/config.js";
import {
  buildLocalSatelliteConfig,
  buildLocalSatelliteEnv,
  containerWakeUri,
  LOCAL_SATELLITE_IMAGE,
  LOCAL_SATELLITE_PINNED_TAG,
  type LocalSatelliteBuildInputs,
} from "../src/local-satellite.js";

function inputs(
  overrides: Partial<LocalSatelliteBuildInputs["local"]> = {},
  wakeUri: string | null = null,
): LocalSatelliteBuildInputs {
  return {
    local: { ...DEFAULT_LOCAL_SATELLITE, ...overrides },
    advanced: { ...DEFAULT_ADVANCED },
    wakeUri,
  };
}

describe("buildLocalSatelliteEnv", () => {
  it("leaves 'auto' devices unset (image defaults apply)", () => {
    const env = buildLocalSatelliteEnv(inputs());
    expect(env.MIC_DEVICE).toBeUndefined();
    expect(env.SND_DEVICE).toBeUndefined();
  });

  it("passes explicit devices (incl. 'none' mic)", () => {
    const env = buildLocalSatelliteEnv(
      inputs({ micDevice: "none", sndDevice: "plughw:CARD=Device,DEV=0" }),
    );
    expect(env.MIC_DEVICE).toBe("none");
    expect(env.SND_DEVICE).toBe("plughw:CARD=Device,DEV=0");
  });

  it("wires WAKE_URI only when wake service resolved AND wakeWords set", () => {
    // no wake service
    expect(
      buildLocalSatelliteEnv(inputs({ wakeWords: ["okay_nabu"] }, null))
        .WAKE_URI,
    ).toBeUndefined();
    // no wake words
    expect(
      buildLocalSatelliteEnv(inputs({}, "tcp://127.0.0.1:10400")).WAKE_URI,
    ).toBeUndefined();
    // both
    const env = buildLocalSatelliteEnv(
      inputs(
        { wakeWords: ["okay_nabu", "hey_jarvis"] },
        "tcp://127.0.0.1:10400",
      ),
    );
    expect(env.WAKE_URI).toBe("tcp://skhost:10400");
    expect(env.WAKE_WORD_NAME).toBe("okay_nabu hey_jarvis");
    expect(env.WAKE_REFRACTORY_SECONDS).toBe("3");
  });

  it("derives WAKE_URI from the resolved wake service URI", () => {
    // Loopback (sibling openwakeword default emission) → skhost alias, at
    // the emitted port.
    expect(
      buildLocalSatelliteEnv(
        inputs({ wakeWords: ["okay_nabu"] }, "tcp://127.0.0.1:11400"),
      ).WAKE_URI,
    ).toBe("tcp://skhost:11400");
    // Manual off-box override (spec §3.1) passes through verbatim — NOT the
    // sibling default.
    expect(
      buildLocalSatelliteEnv(
        inputs({ wakeWords: ["okay_nabu"] }, "tcp://192.168.1.50:10400"),
      ).WAKE_URI,
    ).toBe("tcp://192.168.1.50:10400");
  });

  it("containerWakeUri maps loopback/wildcard hosts to skhost", () => {
    expect(containerWakeUri("tcp://127.0.0.1:10400")).toBe(
      "tcp://skhost:10400",
    );
    expect(containerWakeUri("tcp://localhost:10400")).toBe(
      "tcp://skhost:10400",
    );
    expect(containerWakeUri("tcp://[::1]:10400")).toBe("tcp://skhost:10400");
    expect(containerWakeUri("tcp://0.0.0.0:10400")).toBe("tcp://skhost:10400");
    expect(containerWakeUri("tcp://gpubox:10400")).toBe("tcp://gpubox:10400");
    // Unparseable input passes through rather than breaking startup.
    expect(containerWakeUri("not a uri")).toBe("not a uri");
  });

  it("maps audio knobs when set", () => {
    const env = buildLocalSatelliteEnv(
      inputs({ noiseSuppression: 2, autoGain: 15, micVolume: 1.5 }),
    );
    expect(env.NOISE_SUPPRESSION).toBe("2");
    expect(env.AUTO_GAIN).toBe("15");
    expect(env.MIC_VOLUME).toBe("1.5");
    const bare = buildLocalSatelliteEnv(inputs());
    expect(bare.NOISE_SUPPRESSION).toBeUndefined();
  });

  it("disables feedback WAVs when feedbackSounds is false", () => {
    const env = buildLocalSatelliteEnv(inputs({ feedbackSounds: false }));
    expect(env.AWAKE_WAV).toBe("none");
    expect(env.DONE_WAV).toBe("none");
    const on = buildLocalSatelliteEnv(inputs());
    expect(on.AWAKE_WAV).toBeUndefined();
  });

  it("sets PULSE_SERVER in pulse-socket mode", () => {
    const env = buildLocalSatelliteEnv(inputs({ audioMode: "pulse-socket" }));
    expect(env.PULSE_SERVER).toBe("unix:///run/pulse-socket");
  });
});

describe("buildLocalSatelliteConfig", () => {
  it("builds the M1 container config shape", () => {
    const config = buildLocalSatelliteConfig("0.1.0", inputs());
    expect(config.image).toBe(LOCAL_SATELLITE_IMAGE);
    expect(config.tag).toBe("0.1.0");
    expect(config.signalkAccessiblePorts).toEqual([10700, 10800]);
    expect(config.restart).toBe("unless-stopped");
    expect(config.resources).toEqual({ memory: "256m", memorySwap: "256m" });
    // Forward-compat fields (silently dropped by signalk-container 1.23.2)
    const forward = config as { devices?: string[]; groupAdd?: string[] };
    expect(forward.devices).toEqual(["/dev/snd"]);
    expect(forward.groupAdd).toEqual(["audio"]);
    expect(config.extraHosts).toBeUndefined();
    expect(config.volumes).toBeUndefined();
  });

  it("adds extraHosts host-gateway alias only when wake is wired", () => {
    const config = buildLocalSatelliteConfig(
      "0.1.0",
      inputs({ wakeWords: ["okay_nabu"] }, "tcp://127.0.0.1:10400"),
    );
    expect(config.extraHosts).toEqual({ skhost: "host-gateway" });
  });

  it("mounts the host pulse socket in pulse-socket mode", () => {
    const config = buildLocalSatelliteConfig(
      "0.1.0",
      inputs({
        audioMode: "pulse-socket",
        hostPulseSocket: "/run/user/1000/pulse/native",
      }),
    );
    expect(config.volumes).toEqual({
      "/run/pulse-socket": "/run/user/1000/pulse/native",
    });
  });

  it("pins the 'auto' tag to a real release", () => {
    expect(LOCAL_SATELLITE_PINNED_TAG).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

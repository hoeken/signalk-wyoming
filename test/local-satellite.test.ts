import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ADVANCED, DEFAULT_LOCAL_SATELLITE } from "../src/config.js";
import {
  buildLocalSatelliteConfig,
  buildLocalSatelliteEnv,
  containerWakeUri,
  createLocalSatellite,
  fetchSatelliteImageVersion,
  fetchSatelliteVersions,
  LOCAL_SATELLITE_FLOATING_TAG,
  LOCAL_SATELLITE_IMAGE,
  micWithoutWakeWordsWarning,
  SATELLITE_TAGS_URL,
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

describe("micWithoutWakeWordsWarning", () => {
  const local = (
    overrides: Partial<LocalSatelliteBuildInputs["local"]> = {},
  ) => ({ ...DEFAULT_LOCAL_SATELLITE, ...overrides });

  it("warns when a mic is configured with no wake words", () => {
    const warning = micWithoutWakeWordsWarning(
      local({ enabled: true, micDevice: "plughw:CARD=USB,DEV=0" }),
    );
    expect(warning).not.toBeNull();
    expect(warning).toContain("plughw:CARD=USB,DEV=0");
    expect(warning).toContain("no wake words");
  });

  it("names the wake words the boat's wake service offers", () => {
    const warning = micWithoutWakeWordsWarning(
      local({ enabled: true, micDevice: "plughw:CARD=USB,DEV=0" }),
      ["okay_nabu", "hey_jarvis"],
    );
    expect(warning).toContain("okay_nabu, hey_jarvis");
  });

  it("warns for 'auto' too — auto resolves to a real capture device", () => {
    expect(micWithoutWakeWordsWarning(local({ enabled: true }))).not.toBeNull();
  });

  it("stays quiet when wake words are configured", () => {
    expect(
      micWithoutWakeWordsWarning(
        local({ enabled: true, wakeWords: ["okay_nabu"] }),
      ),
    ).toBeNull();
  });

  it("stays quiet for a deliberately announce-only satellite", () => {
    expect(
      micWithoutWakeWordsWarning(local({ enabled: true, micDevice: "none" })),
    ).toBeNull();
    expect(
      micWithoutWakeWordsWarning(local({ enabled: true, micDevice: "NONE" })),
    ).toBeNull();
  });

  it("stays quiet when the local satellite is disabled", () => {
    expect(
      micWithoutWakeWordsWarning(
        local({ enabled: false, micDevice: "plughw:CARD=USB,DEV=0" }),
      ),
    ).toBeNull();
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

  it("enables digest tracking so 'auto' → latest follows releases", () => {
    const config = buildLocalSatelliteConfig(
      LOCAL_SATELLITE_FLOATING_TAG,
      inputs(),
    );
    expect(config.autoUpdateOnFloatingTag).toBe(true);
  });
});

function githubTags(names: string[]): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => names.map((name) => ({ name })),
  })) as unknown as typeof fetch;
}

describe("fetchSatelliteVersions", () => {
  it("maps GitHub v-tags to image tags, newest first, prereleases flagged", async () => {
    const fetchImpl = githubTags(["v0.1.0", "v0.2.0-rc1", "v0.1.1", "junk"]);
    const versions = await fetchSatelliteVersions(fetchImpl);
    expect(versions).toEqual([
      { tag: "0.2.0-rc1", prerelease: true },
      { tag: "0.1.1" },
      { tag: "0.1.0" },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      SATELLITE_TAGS_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("throws with the HTTP status on failure (rate limit, offline proxy)", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;
    await expect(fetchSatelliteVersions(fetchImpl)).rejects.toThrow(/403/);
  });
});

describe("fetchSatelliteImageVersion", () => {
  const health = (body: unknown, ok = true): typeof fetch =>
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    })) as unknown as typeof fetch;

  it("reads `version` from the control API /health", async () => {
    const fetchImpl = health({ status: "ok", version: "0.2.0" });
    await expect(
      fetchSatelliteImageVersion("http://127.0.0.1:10800", fetchImpl),
    ).resolves.toBe("0.2.0");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:10800/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null on HTTP failure, malformed body, or network error", async () => {
    await expect(
      fetchSatelliteImageVersion("http://x", health({}, false)),
    ).resolves.toBeNull();
    await expect(
      fetchSatelliteImageVersion("http://x", health({ version: 7 })),
    ).resolves.toBeNull();
    await expect(
      fetchSatelliteImageVersion("http://x", (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

describe("update-detection registration", () => {
  const app = {
    debug: () => {},
    setPluginStatus: () => {},
    setPluginError: () => {},
  };
  const makeHandle = (tag: string, fetchImpl: typeof fetch) =>
    createLocalSatellite({
      app,
      local: { ...DEFAULT_LOCAL_SATELLITE, tag },
      advanced: { ...DEFAULT_ADVANCED },
      wakeUri: () => null,
      fetchImpl,
    });

  it("'auto' maps to the floating latest; explicit tags pass through", () => {
    const handle = makeHandle("auto", githubTags([]));
    expect(handle.container.options.updates?.currentTag?.()).toBe(
      LOCAL_SATELLITE_FLOATING_TAG,
    );
    expect(handle.container.options.resolveTag?.("auto")).toBe(
      LOCAL_SATELLITE_FLOATING_TAG,
    );
    const pinned = makeHandle("0.1.0", githubTags([]));
    expect(pinned.container.options.updates?.currentTag?.()).toBe("0.1.0");
    expect(pinned.container.options.resolveTag?.("0.1.0")).toBe("0.1.0");
  });

  it("currentVersion is null before start (no control address yet)", async () => {
    const handle = makeHandle("auto", githubTags([]));
    await expect(
      handle.container.options.updates?.currentVersion?.(),
    ).resolves.toBeNull();
  });

  it("uses a custom source: latest stable GitHub tag (repo has no Releases)", async () => {
    const handle = makeHandle(
      "auto",
      githubTags(["v0.2.0-rc1", "v0.1.1", "v0.1.0"]),
    );
    const spec = handle.container.options.updates?.versionSource;
    if (spec === undefined || !("custom" in spec)) {
      throw new Error("expected a custom version source");
    }
    const runtime = {} as Parameters<typeof spec.custom.fetch>[0];
    expect(await spec.custom.fetch(runtime)).toEqual({
      kind: "version",
      latest: "0.1.1",
    });
  });

  it("reports fetch failures as an error result, never a throw", async () => {
    const handle = makeHandle("auto", (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch);
    const spec = handle.container.options.updates?.versionSource;
    if (spec === undefined || !("custom" in spec)) {
      throw new Error("expected a custom version source");
    }
    const runtime = {} as Parameters<typeof spec.custom.fetch>[0];
    expect(await spec.custom.fetch(runtime)).toEqual({
      kind: "error",
      error: "GitHub answered HTTP 500",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSchema,
  buildUiSchema,
  DEFAULT_ADVANCED,
  localSatelliteEntry,
  parseConfig,
} from "../src/config.js";

describe("parseConfig defaults", () => {
  it("fills every default from an empty object", () => {
    const cfg = parseConfig({});
    expect(cfg.satellites).toEqual([]);
    expect(cfg.localSatellite.enabled).toBe(false);
    expect(cfg.localSatellite.micDevice).toBe("auto");
    expect(cfg.localSatellite.sndDevice).toBe("auto");
    expect(cfg.localSatellite.audioMode).toBe("alsa");
    expect(cfg.localSatellite.feedbackSounds).toBe(true);
    expect(cfg.localSatellite.wakeWords).toEqual([]);
    expect(cfg.localSatellite.tag).toBe("auto");
    expect(cfg.services).toEqual({ asr: "auto", tts: "auto", wake: "auto" });
    expect(cfg.defaults).toEqual({ language: "en", voice: "" });
    expect(cfg.advanced).toEqual(DEFAULT_ADVANCED);
  });

  it("accepts undefined / non-object input as empty config", () => {
    expect(parseConfig(undefined).satellites).toEqual([]);
    expect(parseConfig(null).satellites).toEqual([]);
  });

  it("spec §4.3 advanced defaults are exact", () => {
    const { advanced } = parseConfig({});
    expect(advanced.silenceMs).toBe(800);
    expect(advanced.maxUtteranceMs).toBe(10000);
    expect(advanced.minUtteranceMs).toBe(300);
    expect(advanced.wakeDedupMs).toBe(2000);
    expect(advanced.pipelineTimeoutMs).toBe(30000);
    expect(advanced.wakeRefractorySeconds).toBe(3.0);
  });
});

describe("parseConfig satellites", () => {
  it("parses a full satellite entry", () => {
    const cfg = parseConfig({
      satellites: [
        {
          id: "cockpit",
          name: "Cockpit",
          host: "10.10.10.21",
          port: 10701,
          wakeWords: ["okay_nabu"],
        },
      ],
    });
    expect(cfg.satellites).toEqual([
      {
        id: "cockpit",
        name: "Cockpit",
        host: "10.10.10.21",
        port: 10701,
        wakeWords: ["okay_nabu"],
      },
    ]);
  });

  it("defaults name to id and port to 10700", () => {
    const cfg = parseConfig({ satellites: [{ id: "salon", host: "h" }] });
    expect(cfg.satellites[0]).toEqual({
      id: "salon",
      name: "salon",
      host: "h",
      port: 10700,
    });
  });

  it("rejects invalid ids, naming the offender", () => {
    expect(() =>
      parseConfig({ satellites: [{ id: "cock pit", host: "h" }] }),
    ).toThrow(/invalid satellite id "cock pit".*a-zA-Z0-9_-/);
    expect(() =>
      parseConfig({ satellites: [{ id: "a/b", host: "h" }] }),
    ).toThrow(/"a\/b"/);
  });

  it("rejects duplicate ids", () => {
    expect(() =>
      parseConfig({
        satellites: [
          { id: "x", host: "h1" },
          { id: "x", host: "h2" },
        ],
      }),
    ).toThrow(/duplicate satellite id "x"/);
  });

  it("rejects a missing host", () => {
    expect(() => parseConfig({ satellites: [{ id: "x" }] })).toThrow(
      /host is required/,
    );
  });

  it("rejects out-of-range and non-integer ports", () => {
    expect(() =>
      parseConfig({ satellites: [{ id: "x", host: "h", port: 0 }] }),
    ).toThrow(/port/);
    expect(() =>
      parseConfig({ satellites: [{ id: "x", host: "h", port: 1.5 }] }),
    ).toThrow(/port/);
    expect(() =>
      parseConfig({ satellites: [{ id: "x", host: "h", port: 70000 }] }),
    ).toThrow(/port/);
  });

  it("rejects non-string wakeWords", () => {
    expect(() =>
      parseConfig({ satellites: [{ id: "x", host: "h", wakeWords: [1] }] }),
    ).toThrow(/wakeWords/);
  });

  it("parses hasControlApi/controlPort (our-image remote satellites, SPEC §4.4)", () => {
    const cfg = parseConfig({
      satellites: [
        { id: "plain", host: "h" },
        { id: "ours", host: "h", hasControlApi: true },
        { id: "custom", host: "h", controlPort: 18800 },
        { id: "off", host: "h", hasControlApi: false },
      ],
    });
    // Plain remote satellites stay control-API-less.
    expect(cfg.satellites[0]?.hasControlApi).toBeUndefined();
    expect(cfg.satellites[0]?.controlPort).toBeUndefined();
    // hasControlApi defaults the port to 10800.
    expect(cfg.satellites[1]).toMatchObject({
      hasControlApi: true,
      controlPort: 10800,
    });
    // An explicit controlPort implies hasControlApi.
    expect(cfg.satellites[2]).toMatchObject({
      hasControlApi: true,
      controlPort: 18800,
    });
    expect(cfg.satellites[3]?.hasControlApi).toBeUndefined();
  });

  it("rejects invalid controlPort values", () => {
    expect(() =>
      parseConfig({
        satellites: [
          { id: "x", host: "h", hasControlApi: true, controlPort: 0 },
        ],
      }),
    ).toThrow(/controlPort/);
    expect(() =>
      parseConfig({
        satellites: [{ id: "x", host: "h", controlPort: 1.5 }],
      }),
    ).toThrow(/controlPort/);
    expect(() =>
      parseConfig({
        satellites: [{ id: "x", host: "h", hasControlApi: "yes" }],
      }),
    ).toThrow(/hasControlApi/);
  });

  it("rejects a non-array satellites field", () => {
    expect(() => parseConfig({ satellites: {} })).toThrow(
      /satellites must be an array/,
    );
  });

  it("reserves id 'local' while the local satellite is enabled", () => {
    expect(() =>
      parseConfig({
        satellites: [{ id: "local", host: "h" }],
        localSatellite: { enabled: true },
      }),
    ).toThrow(/"local" is reserved/);
    // ...but allows it when disabled.
    const cfg = parseConfig({ satellites: [{ id: "local", host: "h" }] });
    expect(cfg.satellites[0]?.id).toBe("local");
  });
});

describe("parseConfig services / defaults / advanced / localSatellite", () => {
  it("accepts manual tcp:// URIs and 'auto'", () => {
    const cfg = parseConfig({
      services: { asr: "tcp://gpu-box:10300", tts: "auto", wake: "" },
    });
    expect(cfg.services.asr).toBe("tcp://gpu-box:10300");
    expect(cfg.services.tts).toBe("auto");
    expect(cfg.services.wake).toBe("auto");
  });

  it("rejects invalid service URIs", () => {
    expect(() => parseConfig({ services: { tts: "http://x:1" } })).toThrow(
      /services\.tts/,
    );
    expect(() => parseConfig({ services: { asr: "nonsense" } })).toThrow(
      /services\.asr/,
    );
  });

  it("rejects non-positive advanced tunables", () => {
    expect(() => parseConfig({ advanced: { silenceMs: 0 } })).toThrow(
      /silenceMs/,
    );
    expect(() => parseConfig({ advanced: { wakeDedupMs: -1 } })).toThrow(
      /wakeDedupMs/,
    );
  });

  it("merges partial advanced overrides over defaults", () => {
    const cfg = parseConfig({ advanced: { silenceMs: 500 } });
    expect(cfg.advanced.silenceMs).toBe(500);
    expect(cfg.advanced.maxUtteranceMs).toBe(10000);
  });

  it("rejects an unknown audioMode", () => {
    expect(() =>
      parseConfig({ localSatellite: { audioMode: "jack" } }),
    ).toThrow(/audioMode/);
  });

  it("parses numeric localSatellite audio knobs", () => {
    const cfg = parseConfig({
      localSatellite: { noiseSuppression: 2, autoGain: 15, micVolume: 1.5 },
    });
    expect(cfg.localSatellite.noiseSuppression).toBe(2);
    expect(cfg.localSatellite.autoGain).toBe(15);
    expect(cfg.localSatellite.micVolume).toBe(1.5);
    expect(() => parseConfig({ localSatellite: { autoGain: "loud" } })).toThrow(
      /autoGain/,
    );
  });

  it("defaults the hardware mixer levels to full scale", () => {
    // Deliberately not "leave the card alone": no default is what let a USB
    // speakerphone sit at -20 dB and read as a dead speaker.
    const cfg = parseConfig({ localSatellite: { enabled: true } });
    expect(cfg.localSatellite.sndMixerVolume).toBe(100);
    expect(cfg.localSatellite.micMixerVolume).toBe(100);
  });

  it("parses explicit mixer levels, including 0", () => {
    const cfg = parseConfig({
      localSatellite: { sndMixerVolume: 0, micMixerVolume: 65 },
    });
    expect(cfg.localSatellite.sndMixerVolume).toBe(0);
    expect(cfg.localSatellite.micMixerVolume).toBe(65);
  });

  it("rejects out-of-range and non-numeric mixer levels", () => {
    for (const bad of [101, -1]) {
      expect(() =>
        parseConfig({ localSatellite: { sndMixerVolume: bad } }),
      ).toThrow(/sndMixerVolume must be between 0 and 100/);
    }
    expect(() =>
      parseConfig({ localSatellite: { micMixerVolume: "loud" } }),
    ).toThrow(/micMixerVolume must be a number/);
  });

  it("ignores unknown top-level fields", () => {
    expect(() => parseConfig({ bogus: true, satellites: [] })).not.toThrow();
  });
});

describe("schema and local satellite entry", () => {
  it("localSatelliteEntry is the synthetic 'local' satellite", () => {
    expect(localSatelliteEntry()).toEqual({
      id: "local",
      name: "Local satellite",
      port: 10700,
    });
  });

  it("buildSchema mirrors the config shape", () => {
    const schema = buildSchema() as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual([
      "satellites",
      "localSatellite",
      "services",
      "defaults",
      "advanced",
    ]);
    const sats = schema.properties.satellites as {
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(sats.items.required).toEqual(["id", "host"]);
    expect(Object.keys(sats.items.properties)).toContain("wakeWords");
  });

  it("buildUiSchema collapses the advanced section", () => {
    const ui = buildUiSchema() as Record<string, Record<string, unknown>>;
    expect(ui.advanced?.["ui:field"]).toBe("collapsible");
  });
});

describe("speechMinRms default", () => {
  it("matches the endpointer's absolute threshold", async () => {
    // config.ts duplicates the value rather than importing it: the import
    // creates a config -> endpointer -> index cycle that breaks the plugin at
    // load time. This test is what keeps the copy honest.
    const { SPEECH_ABS_MIN_RMS } = await import("../src/endpointer.js");
    expect(DEFAULT_ADVANCED.speechMinRms).toBe(SPEECH_ABS_MIN_RMS);
  });
});

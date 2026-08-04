import { describe, expect, it, vi } from "vitest";
import { ServiceDirectory, type ServiceType } from "../src/discovery.js";

function pv(plugin: string, type: string, uri: string, status: string) {
  return {
    timestamp: Date.now(),
    setter: plugin,
    name: "wyoming-service",
    value: { plugin, type, uri, status },
  };
}

function makeDirectory(overrides?: Partial<Record<ServiceType, string>>) {
  const directory = new ServiceDirectory({
    overrides: { asr: "auto", tts: "auto", wake: "auto", ...overrides },
  });
  let callback: ((history: unknown[]) => void) | null = null;
  const unsubscribe = vi.fn();
  directory.start((name, cb) => {
    expect(name).toBe("wyoming-service");
    callback = cb;
    return unsubscribe;
  });
  const push = (history: unknown[]) => callback?.(history);
  return { directory, push, unsubscribe };
}

describe("ServiceDirectory", () => {
  it("resolves nothing before any emission", () => {
    const { directory } = makeDirectory();
    expect(directory.get("tts")).toBeNull();
    expect(directory.snapshot()).toEqual({
      asr: { uri: null, status: null, source: null },
      tts: { uri: null, status: null, source: null },
      wake: { uri: null, status: null, source: null },
    });
  });

  it("resolves a ready emission (history has a leading undefined)", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
    ]);
    expect(directory.get("tts")).toEqual({
      uri: "tcp://localhost:10200",
      plugin: "signalk-piper",
      status: "ready",
      source: "auto",
    });
  });

  it("latest emission per plugin wins", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
      pv("signalk-piper", "tts", "tcp://localhost:10200", "error"),
    ]);
    expect(directory.get("tts")?.status).toBe("error");
  });

  it("status 'stopped' removes the service", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
      pv("signalk-piper", "tts", "tcp://localhost:10200", "stopped"),
    ]);
    expect(directory.get("tts")).toBeNull();
  });

  it("a stopped plugin falls back to another plugin advertising the same type", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("third-party-tts", "tts", "tcp://ha:10201", "ready"),
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
      pv("signalk-piper", "tts", "tcp://localhost:10200", "stopped"),
    ]);
    expect(directory.get("tts")).toMatchObject({
      uri: "tcp://ha:10201",
      plugin: "third-party-tts",
    });
  });

  it("newest emission wins across plugins of the same type", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("a", "asr", "tcp://a:10300", "ready"),
      pv("b", "asr", "tcp://b:10300", "ready"),
    ]);
    expect(directory.get("asr")?.plugin).toBe("b");
  });

  it("tolerates malformed emissions", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      null,
      42,
      { value: "not an object" },
      { value: { plugin: "x" } }, // missing fields
      {
        value: { plugin: "x", type: "nlu", uri: "tcp://x:1", status: "ready" },
      }, // bad type
      { value: { plugin: "x", type: "tts", uri: "", status: "ready" } }, // empty uri
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
    ]);
    expect(directory.get("tts")?.plugin).toBe("signalk-piper");
    expect(directory.get("asr")).toBeNull();
  });

  it("manual override always resolves ready and masks discovery", () => {
    const { directory, push } = makeDirectory({ tts: "tcp://gpu:10200" });
    expect(directory.get("tts")).toEqual({
      uri: "tcp://gpu:10200",
      status: "ready",
      source: "manual",
    });
    push([
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "error"),
    ]);
    expect(directory.get("tts")).toEqual({
      uri: "tcp://gpu:10200",
      status: "ready",
      source: "manual",
    });
    expect(directory.snapshot().tts.source).toBe("manual");
  });

  it("emits 'change' only on real changes, not for overridden types", () => {
    const { directory, push } = makeDirectory({ wake: "tcp://w:10400" });
    const changes: [ServiceType, unknown][] = [];
    directory.on("change", (type: ServiceType, resolved: unknown) => {
      changes.push([type, resolved]);
    });
    const history: unknown[] = [
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
    ];
    push(history);
    push(history); // same history again → no change
    history.push(pv("oww", "wake", "tcp://localhost:10400", "ready"));
    push(history); // wake is overridden → masked, no event
    history.push(pv("signalk-piper", "tts", "tcp://localhost:10200", "error"));
    push(history);
    expect(changes.map(([t]) => t)).toEqual(["tts", "tts"]);
    expect((changes[1]?.[1] as { status: string }).status).toBe("error");
  });

  it("stop() unsubscribes and ignores late callbacks", () => {
    const { directory, push, unsubscribe } = makeDirectory();
    directory.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    push([
      undefined,
      pv("signalk-piper", "tts", "tcp://localhost:10200", "ready"),
    ]);
    expect(directory.get("tts")).toBeNull();
  });

  it("snapshot includes plugin for auto sources", () => {
    const { directory, push } = makeDirectory();
    push([
      undefined,
      pv("signalk-whisper", "asr", "tcp://localhost:10300", "starting"),
    ]);
    expect(directory.snapshot().asr).toEqual({
      uri: "tcp://localhost:10300",
      status: "starting",
      source: "auto",
      plugin: "signalk-whisper",
    });
  });
});

describe("advertised wake words (§3.1 optional extension)", () => {
  const pvw = (words: unknown) => ({
    timestamp: Date.now(),
    setter: "signalk-openwakeword",
    name: "wyoming-service",
    value: {
      plugin: "signalk-openwakeword",
      type: "wake",
      uri: "tcp://127.0.0.1:10400",
      status: "ready",
      wakeWords: words,
    },
  });

  it("carries the advertised wake words through to the resolved service", () => {
    const { directory, push } = makeDirectory();
    push([pvw(["hey_moin"])]);
    expect(directory.get("wake")?.wakeWords).toEqual(["hey_moin"]);
  });

  it("leaves wakeWords undefined when the service does not advertise any", () => {
    const { directory, push } = makeDirectory();
    push([
      pv("signalk-openwakeword", "wake", "tcp://127.0.0.1:10400", "ready"),
    ]);
    expect(directory.get("wake")?.wakeWords).toBeUndefined();
  });

  // The spec explicitly allows unknown fields, so a malformed one must never
  // break discovery — the service is still usable, just without inheritance.
  it.each([
    ["not an array", "hey_moin"],
    ["an empty array", []],
    ["entries that are not strings", [1, 2]],
    ["blank strings", ["   "]],
  ])("ignores wakeWords that is %s", (_label, words) => {
    const { directory, push } = makeDirectory();
    push([pvw(words)]);
    expect(directory.get("wake")?.uri).toBe("tcp://127.0.0.1:10400");
    expect(directory.get("wake")?.wakeWords).toBeUndefined();
  });

  it("keeps only the well-formed entries", () => {
    const { directory, push } = makeDirectory();
    push([pvw(["hey_moin", "", 7, "okay_nabu"])]);
    expect(directory.get("wake")?.wakeWords).toEqual(["hey_moin", "okay_nabu"]);
  });

  // Inheriting satellites re-wire on this event, so a changed wake word has
  // to count as a change even though the URI and status are identical.
  it("emits change when only the wake words differ", () => {
    const { directory, push } = makeDirectory();
    const seen: (string[] | undefined)[] = [];
    directory.on("change", (type, resolved) => {
      if (type === "wake") seen.push(resolved?.wakeWords);
    });
    push([pvw(["hey_moin"])]);
    push([pvw(["hey_moin"])]); // identical: no second event
    push([pvw(["okay_nabu"])]);
    expect(seen).toEqual([["hey_moin"], ["okay_nabu"]]);
  });
});

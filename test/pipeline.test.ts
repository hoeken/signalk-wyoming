import { describe, expect, it } from "vitest";
import { EnergyGateEndpointer } from "../src/endpointer.js";
import {
  PipelineEngine,
  type PipelineEngineDeps,
  type PipelineQueue,
  type PipelineSatellite,
} from "../src/pipeline.js";
import type { VoiceCommand } from "../src/paths.js";
import type {
  AudioChunk as AudioChunkData,
  RunPipeline,
} from "../src/protocol/events.js";
import type { SatelliteState, TimerApi } from "../src/types.js";
import { ambientChunk, speechChunk } from "./pcm.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Deterministic clock + timers (no vi fake timers — promises stay real)
// ---------------------------------------------------------------------------

function makeClock() {
  let now = 0;
  const scheduled: { at: number; fn: () => void }[] = [];
  const timers: TimerApi = {
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      scheduled.push(t);
      return t;
    },
    clearTimeout: (handle) => {
      const idx = scheduled.indexOf(handle as { at: number; fn: () => void });
      if (idx !== -1) scheduled.splice(idx, 1);
    },
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = scheduled
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        scheduled.splice(scheduled.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSat extends PipelineSatellite {
  states: SatelliteState[];
  transcripts: string[];
  errors: { code: string; text: string }[];
}

function fakeSat(id = "s1"): FakeSat {
  const sat: FakeSat = {
    id,
    state: "idle",
    states: [],
    transcripts: [],
    errors: [],
    setState(state: SatelliteState) {
      sat.state = state;
      sat.states.push(state);
    },
    sendTranscript(text: string) {
      sat.transcripts.push(text);
      if (sat.state === "listening" || sat.state === "transcribing") {
        sat.setState("idle");
      }
    },
    sendError(code: string, text: string) {
      sat.errors.push({ code, text });
      if (sat.state === "listening" || sat.state === "transcribing") {
        sat.setState("idle");
      }
    },
  };
  return sat;
}

interface FakeQueue extends PipelineQueue {
  interrupted: number;
  doneCalls: number;
}

function fakeQueue(opts: { urgentPlaying?: boolean } = {}): FakeQueue {
  const queue: FakeQueue = {
    playing: opts.urgentPlaying === true ? { priority: "urgent" } : null,
    interrupted: 0,
    doneCalls: 0,
    interruptForPipeline() {
      if (opts.urgentPlaying === true) return false;
      queue.interrupted++;
      return true;
    },
    pipelineDone() {
      queue.doneCalls++;
    },
  };
  return queue;
}

interface FakeAsr {
  fed: Buffer[];
  finishCalls: number;
  aborted: boolean;
  feedError: Error | null;
  feed(chunk: Buffer): void;
  finish(timeoutMs: number): Promise<{ text: string }>;
  abort(): void;
  resolveFinish(text: string): void;
  rejectFinish(err: Error): void;
}

function fakeAsr(): FakeAsr {
  let resolve!: (v: { text: string }) => void;
  let reject!: (err: Error) => void;
  const finished = new Promise<{ text: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const asr: FakeAsr = {
    fed: [],
    finishCalls: 0,
    aborted: false,
    feedError: null,
    feed(chunk: Buffer) {
      if (asr.feedError !== null) throw asr.feedError;
      asr.fed.push(chunk);
    },
    finish() {
      asr.finishCalls++;
      return finished;
    },
    abort() {
      asr.aborted = true;
    },
    resolveFinish: (text) => resolve({ text }),
    rejectFinish: (err) => reject(err),
  };
  return asr;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeEngine(overrides: Partial<PipelineEngineDeps> = {}) {
  const clock = makeClock();
  const published: VoiceCommand[] = [];
  const notifications: { service: string; state: string; message: string }[] =
    [];
  const emitted: { kind: string; data: unknown }[] = [];
  const logs: string[] = [];
  const queues = new Map<string, FakeQueue>();
  const asrs: FakeAsr[] = [];
  const deps: PipelineEngineDeps = {
    directory: { get: () => ({ uri: "tcp://127.0.0.1:1" }) },
    queueFor: (id) => queues.get(id) ?? null,
    publishCommand: (cmd) => published.push(cmd),
    notify: (service, state, message) =>
      notifications.push({ service, state, message }),
    emit: (kind, data) => emitted.push({ kind, data }),
    endpointerFactory: () =>
      new EnergyGateEndpointer({
        silenceMs: 200,
        minUtteranceMs: 100,
        maxUtteranceMs: 2000,
      }),
    asrOpen: () => {
      const asr = fakeAsr();
      asrs.push(asr);
      return Promise.resolve(asr);
    },
    advanced: { wakeDedupMs: 2000, pipelineTimeoutMs: 5000 },
    language: "en",
    log: (msg) => logs.push(msg),
    now: clock.now,
    timers: clock.timers,
    ...overrides,
  };
  return {
    engine: new PipelineEngine(deps),
    clock,
    published,
    notifications,
    emitted,
    logs,
    queues,
    asrs,
  };
}

const rp = (): RunPipeline => ({
  startStage: "asr",
  endStage: "tts",
  restartOnEnd: false,
});

function chunk(pcm: Buffer): AudioChunkData {
  return { rate: 16000, width: 2, channels: 1, audio: pcm };
}

/** 3 ambient (floor seed) + 3 speech + 4 ambient → endpointer 'end'. */
function feedUtterance(engine: PipelineEngine, sat: PipelineSatellite): void {
  for (let i = 0; i < 3; i++) engine.onAudioChunk(sat, chunk(ambientChunk()));
  for (let i = 0; i < 3; i++) engine.onAudioChunk(sat, chunk(speechChunk()));
  for (let i = 0; i < 4; i++) engine.onAudioChunk(sat, chunk(ambientChunk()));
}

// ---------------------------------------------------------------------------

describe("PipelineEngine — happy path", () => {
  it("wake → listening → endpoint → transcribing → transcript → voice.command", async () => {
    const h = makeEngine();
    const sat = fakeSat("cockpit");
    const queue = fakeQueue();
    h.queues.set("cockpit", queue);

    h.engine.onDetection("cockpit", { name: "okay_nabu" });
    h.engine.onRunPipeline(sat, rp());
    expect(sat.state).toBe("listening");
    expect(queue.interrupted).toBe(1); // queue paused for the pipeline
    await tick();

    feedUtterance(h.engine, sat);
    expect(sat.state).toBe("transcribing");
    expect(h.asrs[0]?.fed).toHaveLength(10); // every chunk forwarded
    await tick(); // finishSession awaits asrReady before calling finish()
    expect(h.asrs[0]?.finishCalls).toBe(1);

    h.clock.advance(1500);
    h.asrs[0]?.resolveFinish("log my position");
    await tick();

    expect(sat.transcripts).toEqual(["log my position"]);
    expect(sat.state).toBe("idle");
    expect(h.published).toHaveLength(1);
    const cmd = h.published[0] as VoiceCommand;
    expect(cmd.id).toMatch(UUID_RE);
    expect(cmd).toMatchObject({
      text: "log my position",
      satellite: "cockpit",
      language: "en",
      wakeWord: "okay_nabu",
      durationMs: 1500,
    });
    expect(queue.doneCalls).toBe(1);
    expect(
      h.emitted.filter((e) => e.kind === "command").map((e) => e.data),
    ).toEqual([cmd]);
    expect(h.engine.activeSessions).toBe(0);
  });

  it("buffers mic chunks until the ASR connection is up, then flushes in order", async () => {
    let open!: (asr: FakeAsr) => void;
    const h = makeEngine({
      asrOpen: () =>
        new Promise((resolve) => {
          open = resolve as (asr: FakeAsr) => void;
        }),
    });
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    const chunks = [ambientChunk(), speechChunk(), ambientChunk()];
    for (const pcm of chunks) h.engine.onAudioChunk(sat, chunk(pcm));

    const asr = fakeAsr();
    open(asr);
    await tick();
    expect(asr.fed).toHaveLength(3);
    expect(asr.fed.map((b) => b.equals(chunks[asr.fed.indexOf(b)] as Buffer)));
    expect(asr.fed[1]?.equals(chunks[1] as Buffer)).toBe(true);

    h.engine.onAudioChunk(sat, chunk(speechChunk()));
    expect(asr.fed).toHaveLength(4);
  });

  it("empty transcript: relayed to the satellite (done sound) but voice.command NOT published", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    await tick();
    feedUtterance(h.engine, sat);
    h.asrs[0]?.resolveFinish("");
    await tick();
    expect(sat.transcripts).toEqual([""]);
    expect(h.published).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("empty transcript"))).toBe(true);
    expect(sat.state).toBe("idle");
  });

  it("wakeWord falls back to run-pipeline data when no detection was seen", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, { ...rp(), wakeWordName: "hey_jarvis" });
    await tick();
    feedUtterance(h.engine, sat);
    h.asrs[0]?.resolveFinish("hello");
    await tick();
    expect(h.published[0]?.wakeWord).toBe("hey_jarvis");
  });
});

describe("PipelineEngine — wake dedup (first wins)", () => {
  it("a second run-pipeline within wakeDedupMs gets a wake-dedup error; the winner completes", async () => {
    const h = makeEngine();
    const winner = fakeSat("s1");
    const loser = fakeSat("s2");
    const loserQueue = fakeQueue();
    h.queues.set("s2", loserQueue);

    h.engine.onRunPipeline(winner, rp());
    await tick();
    h.clock.advance(500);
    h.engine.onRunPipeline(loser, rp());

    expect(loser.errors).toEqual([
      { code: "wake-dedup", text: expect.stringContaining("first") as string },
    ]);
    expect(loserQueue.interrupted).toBe(0); // loser's queue untouched
    expect(h.engine.activeSessions).toBe(1);

    feedUtterance(h.engine, winner);
    h.asrs[0]?.resolveFinish("winner speaks");
    await tick();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.satellite).toBe("s1");
    expect(winner.transcripts).toEqual(["winner speaks"]);
  });

  it("a wake after the dedup window starts a second, concurrent session", async () => {
    const h = makeEngine();
    const a = fakeSat("s1");
    const b = fakeSat("s2");
    h.engine.onRunPipeline(a, rp());
    h.clock.advance(2500);
    h.engine.onRunPipeline(b, rp());
    expect(b.errors).toHaveLength(0);
    expect(h.engine.activeSessions).toBe(2);
    await tick();

    feedUtterance(h.engine, a);
    feedUtterance(h.engine, b);
    h.asrs[0]?.resolveFinish("from s1");
    h.asrs[1]?.resolveFinish("from s2");
    await tick();
    expect(h.published.map((c) => c.satellite).sort()).toEqual(["s1", "s2"]);
  });

  it("a duplicate run-pipeline from the same satellite is ignored", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    h.engine.onRunPipeline(sat, rp());
    expect(sat.errors).toHaveLength(0);
    expect(h.engine.activeSessions).toBe(1);
    expect(h.logs.some((l) => l.includes("already active"))).toBe(true);
  });
});

describe("PipelineEngine — queue interplay (§2.5)", () => {
  it("refuses a wake during urgent playback (busy-urgent)", () => {
    const h = makeEngine();
    const sat = fakeSat();
    sat.state = "speaking";
    h.queues.set("s1", fakeQueue({ urgentPlaying: true }));
    h.engine.onRunPipeline(sat, rp());
    expect(sat.errors).toEqual([
      { code: "busy-urgent", text: expect.any(String) as string },
    ]);
    expect(sat.state).toBe("speaking"); // speaking state undisturbed
    expect(h.engine.activeSessions).toBe(0);
  });

  it("barges in during normal playback (queue interrupted, session starts)", () => {
    const h = makeEngine();
    const sat = fakeSat();
    sat.state = "speaking";
    const queue = fakeQueue();
    h.queues.set("s1", queue);
    h.engine.onRunPipeline(sat, rp());
    expect(queue.interrupted).toBe(1);
    expect(sat.state).toBe("listening");
    expect(h.engine.activeSessions).toBe(1);
  });

  it("cancelForUrgent aborts the session: ASR aborted, error sent, nothing published, queue resumed", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    const queue = fakeQueue();
    h.queues.set("s1", queue);
    h.engine.onRunPipeline(sat, rp());
    await tick();
    h.engine.onAudioChunk(sat, chunk(speechChunk()));

    h.engine.cancelForUrgent("s1");
    expect(sat.errors).toEqual([
      { code: "cancelled", text: expect.stringContaining("urgent") as string },
    ]);
    expect(h.asrs[0]?.aborted).toBe(true);
    expect(queue.doneCalls).toBe(1);
    expect(h.engine.activeSessions).toBe(0);

    // A transcript arriving after the cancel publishes nothing.
    h.asrs[0]?.resolveFinish("too late");
    await tick();
    expect(h.published).toHaveLength(0);
    expect(sat.transcripts).toHaveLength(0);
  });

  it("cancelForUrgent without an active session is a no-op", () => {
    const h = makeEngine();
    expect(() => h.engine.cancelForUrgent("ghost")).not.toThrow();
  });
});

describe("PipelineEngine — degraded modes and failures", () => {
  it("no ASR service: no-asr error, notifications.voice.asr alarm, queue resumed", () => {
    const h = makeEngine({ directory: { get: () => null } });
    const sat = fakeSat();
    const queue = fakeQueue();
    h.queues.set("s1", queue);
    h.engine.onRunPipeline(sat, rp());
    expect(sat.errors[0]?.code).toBe("no-asr");
    expect(queue.doneCalls).toBe(1);
    expect(h.notifications).toEqual([
      {
        service: "asr",
        state: "alarm",
        message: expect.stringContaining("signalk-whisper") as string,
      },
    ]);
    expect(
      h.emitted.some(
        (e) =>
          e.kind === "error" && (e.data as { code: string }).code === "no-asr",
      ),
    ).toBe(true);
    expect(h.engine.activeSessions).toBe(0);
  });

  it("pipeline timeout: watchdog aborts, error 'timeout', alarm, queue resumed", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    const queue = fakeQueue();
    h.queues.set("s1", queue);
    h.engine.onRunPipeline(sat, rp());
    await tick();
    h.engine.onAudioChunk(sat, chunk(speechChunk()));

    h.clock.advance(5000);
    expect(sat.errors[0]?.code).toBe("timeout");
    expect(sat.state).toBe("idle");
    expect(h.asrs[0]?.aborted).toBe(true);
    expect(queue.doneCalls).toBe(1);
    expect(h.notifications[0]).toMatchObject({
      service: "asr",
      state: "alarm",
    });
    expect(h.engine.activeSessions).toBe(0);
    expect(h.published).toHaveLength(0);
  });

  it("a later successful pipeline clears the asr alarm (state normal)", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    h.clock.advance(5000); // timeout → alarm
    expect(h.notifications[0]?.state).toBe("alarm");

    h.engine.onRunPipeline(sat, rp()); // beyond dedup window (5000 > 2000)
    await tick();
    feedUtterance(h.engine, sat);
    h.asrs[1]?.resolveFinish("recovered");
    await tick();
    expect(h.notifications[1]).toMatchObject({
      service: "asr",
      state: "normal",
    });
  });

  it("ASR connection failure aborts with asr-error", async () => {
    const h = makeEngine({
      asrOpen: () => Promise.reject(new Error("connection refused")),
    });
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    await tick();
    expect(sat.errors[0]?.code).toBe("asr-error");
    expect(sat.errors[0]?.text).toContain("connection refused");
    expect(h.engine.activeSessions).toBe(0);
  });

  it("ASR feed failure mid-stream aborts with asr-error", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    await tick();
    const asr = h.asrs[0] as FakeAsr;
    asr.feedError = new Error("socket closed");
    h.engine.onAudioChunk(sat, chunk(speechChunk()));
    expect(sat.errors[0]?.code).toBe("asr-error");
    expect(asr.aborted).toBe(true);
  });

  it("ASR transcription error rejects finish and aborts with asr-error", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    h.engine.onRunPipeline(sat, rp());
    await tick();
    feedUtterance(h.engine, sat);
    h.asrs[0]?.rejectFinish(new Error("model exploded"));
    await tick();
    expect(sat.errors[0]?.code).toBe("asr-error");
    expect(sat.errors[0]?.text).toContain("model exploded");
    expect(h.published).toHaveLength(0);
  });

  it("satellite disconnect mid-pipeline cleans up without writing to it", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    const queue = fakeQueue();
    h.queues.set("s1", queue);
    h.engine.onRunPipeline(sat, rp());
    await tick();
    h.engine.onSatelliteGone("s1");
    expect(sat.errors).toHaveLength(0);
    expect(sat.transcripts).toHaveLength(0);
    expect(h.asrs[0]?.aborted).toBe(true);
    expect(queue.doneCalls).toBe(1);
    expect(h.engine.activeSessions).toBe(0);
  });

  it("stop() aborts every session silently", async () => {
    const h = makeEngine();
    const a = fakeSat("s1");
    const b = fakeSat("s2");
    h.engine.onRunPipeline(a, rp());
    h.clock.advance(2500);
    h.engine.onRunPipeline(b, rp());
    await tick();
    h.engine.stop();
    expect(h.engine.activeSessions).toBe(0);
    expect(h.asrs.every((asr) => asr.aborted)).toBe(true);
    expect(a.errors).toHaveLength(0);
    expect(b.errors).toHaveLength(0);
    // Watchdogs cleared — advancing time does nothing.
    h.clock.advance(60000);
    expect(a.errors).toHaveLength(0);
  });

  it("mic chunks with no session (or after end) are ignored", async () => {
    const h = makeEngine();
    const sat = fakeSat();
    expect(() =>
      h.engine.onAudioChunk(sat, chunk(speechChunk())),
    ).not.toThrow();

    h.engine.onRunPipeline(sat, rp());
    await tick();
    feedUtterance(h.engine, sat); // → ended
    const fed = h.asrs[0]?.fed.length;
    h.engine.onAudioChunk(sat, chunk(speechChunk()));
    expect(h.asrs[0]?.fed.length).toBe(fed); // nothing more forwarded
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SoundLibrary } from "../src/sounds.js";
import { buildWav, sinePcm } from "./pcm.js";

const directories: string[] = [];
function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "signalk-wyoming-sounds-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("SoundLibrary", () => {
  it("provides built-in notification sounds", () => {
    const library = new SoundLibrary();
    expect(
      library
        .list()
        .filter((sound) => sound.builtIn)
        .map((sound) => sound.id),
    ).toEqual(["alarm", "chime", "warning"]);
  });

  it("persists and deletes bounded PCM WAV sounds", () => {
    const path = directory();
    const wav = buildWav(sinePcm(1600, 1000));
    const library = new SoundLibrary(path);
    expect(library.put("bilge", wav.toString("base64"))).toMatchObject({
      id: "bilge",
      builtIn: false,
    });
    expect(new SoundLibrary(path).get("bilge")).toBeDefined();
    expect(library.delete("bilge")).toBe(true);
    expect(new SoundLibrary(path).get("bilge")).toBeUndefined();
  });

  it("rejects unsafe ids, invalid audio, and deletion of built-ins", () => {
    const library = new SoundLibrary(directory());
    expect(() => library.put("../bad", "AA==")).toThrow(/sound id/);
    expect(() =>
      library.put("bad", Buffer.from("not wav").toString("base64")),
    ).toThrow(/WAV/);
    expect(() => library.delete("alarm")).toThrow(/read-only/);
  });
});

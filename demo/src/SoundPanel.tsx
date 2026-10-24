// Tuning panel for the synthesised sounds (open the page with ?sound). The
// sliders write straight into `sound`, so the next sound played uses them;
// "copy values" puts the current settings on the clipboard as JSON.
import { Leva, button, folder, useControls } from "leva";
import { playInflate, playPop, sound } from "balloon-writer/sound";

type Range = { min: number; max: number; step: number };

/** A slider bound to `target[key]`, starting from its current value. */
function slider<T extends object>(target: T, key: { [K in keyof T]: T[K] extends number ? K : never }[keyof T] & string, range: Range, label: string = key) {
  const values = target as Record<string, number>;
  return {
    value: values[key]!,
    ...range,
    label,
    onChange: (v: number) => {
      values[key] = v;
    },
  };
}

const hz = (min: number, max: number): Range => ({ min, max, step: 10 });
const level: Range = { min: 0, max: 1.5, step: 0.01 };
const seconds = (max: number): Range => ({ min: 0.005, max, step: 0.005 });
const q: Range = { min: 0.1, max: 20, step: 0.1 };
const db: Range = { min: -12, max: 24, step: 0.5 };

export function SoundPanel() {
  const { inflate, pop } = sound;
  useControls({
    "play inflate": button(() => playInflate(0)),
    "play pop": button(() => playPop(0)),
    "copy values": button(() => void navigator.clipboard.writeText(JSON.stringify(sound, null, 2))),
    volume: slider(sound, "volume", { min: 0, max: 1.5, step: 0.01 }),
    Inflate: folder({
      inflateLength: slider(inflate, "length", seconds(1.5), "length"),
      inflateVariation: slider(inflate, "variation", { min: 0, max: 0.6, step: 0.01 }, "variation"),
      level: slider(inflate, "level", level),
      breathLevel: slider(inflate, "breathLevel", level),
      attack: slider(inflate, "attack", seconds(0.3)),
      release: slider(inflate, "release", { min: 0.02, max: 0.9, step: 0.01 }),
      lowCut: slider(inflate, "lowCut", hz(20, 1000)),
      highCut: slider(inflate, "highCut", hz(1000, 12000)),
      peak1: slider(inflate, "peak1", hz(200, 10000)),
      peak1Boost: slider(inflate, "peak1Boost", db),
      peak1Q: slider(inflate, "peak1Q", q),
      peak2: slider(inflate, "peak2", hz(200, 10000)),
      peak2Boost: slider(inflate, "peak2Boost", db),
      peak2Q: slider(inflate, "peak2Q", q),
      peak3: slider(inflate, "peak3", hz(100, 6000)),
      peak3Boost: slider(inflate, "peak3Boost", db),
      peak3Q: slider(inflate, "peak3Q", q),
      startDb: slider(inflate, "startDb", { min: -40, max: 0, step: 0.5 }),
      peakAt: slider(inflate, "peakAt", { min: 0.05, max: 0.95, step: 0.01 }),
      tailDb: slider(inflate, "tailDb", { min: -40, max: 0, step: 0.5 }),
      rumbleCutoff: slider(inflate, "rumbleCutoff", hz(40, 1000)),
      rumbleLevel: slider(inflate, "rumbleLevel", level),
      airLevel: slider(inflate, "airLevel", level),
      skinPitch: slider(inflate, "skinPitch", hz(40, 800)),
      skinGlide: slider(inflate, "skinGlide", { min: 0.5, max: 3, step: 0.01 }),
      skinQ: slider(inflate, "skinQ", { min: 1, max: 80, step: 0.5 }),
      skinVibrato: slider(inflate, "skinVibrato", { min: 0, max: 300, step: 5 }),
      skinVibratoRate: slider(inflate, "skinVibratoRate", { min: 0.5, max: 20, step: 0.5 }),
      skinLevel: slider(inflate, "skinLevel", { min: 0, max: 4, step: 0.05 }),
      skinPeakAt: slider(inflate, "skinPeakAt", { min: 0.05, max: 0.95, step: 0.01 }),
      roomLength: slider(inflate, "roomLength", { min: 0, max: 1.5, step: 0.01 }),
      roomLevel: slider(inflate, "roomLevel", { min: 0, max: 2, step: 0.01 }),
    }),
    Pop: folder({
      popLength: slider(pop, "length", seconds(1.5), "length"),
      popVariation: slider(pop, "variation", { min: 0, max: 0.6, step: 0.01 }, "variation"),
      cutoffFrom: slider(pop, "cutoffFrom", hz(100, 12000)),
      cutoffTo: slider(pop, "cutoffTo", hz(50, 6000)),
      cutoffQ: slider(pop, "cutoffQ", q),
      popLowCut: slider(pop, "lowCut", hz(10, 2000), "lowCut"),
      hitLevel: slider(pop, "hitLevel", { min: 0.01, max: 1.5, step: 0.01 }),
      hitLength: slider(pop, "hitLength", seconds(0.2)),
      boomLevel: slider(pop, "boomLevel", level),
    }),
  });
  // Wide enough for the longest labels.
  return <Leva theme={{ sizes: { rootWidth: "340px" } }} />;
}

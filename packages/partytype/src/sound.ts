// Synthesised balloon sounds (Web Audio, no samples): a breath of air
// (matched to a recording) while a letter inflates, and a single bang when it's deleted.
// Everything is built from one shared noise buffer and a few filters, so a
// sound costs a handful of short-lived nodes.

/** Every tunable value, live: the ?sound panel (SoundPanel.tsx) edits these.
 *  Frequencies in Hz, times in seconds, levels as linear gain. */
export const sound = {
  volume: 0.6,
  /** Started from one inflation in a recording of a balloon being blown up,
   *  then tuned by ear: a soft, band-limited breath of noise swelling in and
   *  easing out, under the rubber skin vibrating (a stretched membrane's
   *  modes, rising in pitch cartoon-style with a little wobble) that rings on
   *  for a moment after the breath stops. */
  inflate: {
    length: 0.45,
    /** Random spread (±fraction) on length and pitches, so letters differ. */
    variation: 0.3,
    level: 1,
    /** The breath (its noise, rumble and air), relative to `level`; the skin
     *  and its rubbery ring have their own level. */
    breathLevel: 0.17,
    /** Fade-in from silence, in seconds. */
    attack: 0.12,
    /** Fade-out at the end, as a fraction of the length: a rounded ease to
     *  silence. */
    release: 0.35,
    lowCut: 350,
    highCut: 2800,
    /** Resonances: frequency (Hz), boost (dB), and Q (narrowness). */
    peak1: 3400,
    peak1Boost: 0,
    peak1Q: 1.5,
    peak2: 900,
    peak2Boost: 5,
    peak2Q: 1.5,
    peak3: 450,
    peak3Boost: 2,
    peak3Q: 2,
    /** Level at the start, in dB below the peak. */
    startDb: -26,
    /** Where the peak falls, as a fraction of the length. */
    peakAt: 0.75,
    /** Level at 90% of the way through, in dB below the peak. */
    tailDb: -3,
    rumbleCutoff: 220,
    rumbleLevel: 0.04,
    /** Air: faint noise above 6 kHz, the breath's sheen. */
    airLevel: 0.05,
    /** Skin: the rubber's pitch at the start (Hz) and at the end (fraction). */
    skinPitch: 200,
    skinGlide: 1.5,
    /** Resonance sharpness: higher rings longer after the breath stops. */
    skinQ: 60,
    /** Cartoon wobble on the skin's pitch: depth (cents) and rate (Hz). */
    skinVibrato: 40,
    skinVibratoRate: 7,
    skinLevel: 1.1,
    /** Where the skin is strongest (fraction of the length): late, so it stays
     *  in the background while blowing and comes out as the ring at the end. */
    skinPeakAt: 0.85,
    /** Room: a short echo after the breath stops (the recording's fades over
     *  ~0.1 s instead of cutting off). Length in seconds, level as gain. */
    roomLength: 0.3,
    roomLevel: 0.15,
  },
  pop: {
    /** Random spread (±fraction) on length and brightness. */
    variation: 0.15,
    length: 0.4,
    cutoffFrom: 1640,
    cutoffTo: 3560,
    cutoffQ: 2.6,
    lowCut: 130,
    hitLevel: 1.26,
    hitLength: 0.07,
    boomLevel: 0.6,
  },
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let pink: AudioBuffer | null = null;

/** A second of noise: white, or pink (equal energy per octave, like breath;
 *  Paul Kellet's filter). */
function makeNoise(ctx: BaseAudioContext, kind: "white" | "pink") {
  const buffer = new AudioBuffer({ length: ctx.sampleRate, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") {
      data[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buffer;
}
/** Sounds still playing, so a burst of pops (select all, delete) stays sane. */
let voices = 0;
const MAX_VOICES = 14;

/** Sets up the audio (context, noise, the room's echo) ahead of the first
 *  sound, so the first letter typed doesn't stall on it. The context starts
 *  suspended until the page has had a click or key; the first sound resumes
 *  it. */
export function prepareAudio() {
  const { ctx, master } = audio(false);
  roomBus(ctx, master);
}

function audio(resume = true) {
  if (!ctx) {
    ctx = new AudioContext();
    // A compressor so many letters at once don't clip.
    const compressor = new DynamicsCompressorNode(ctx, { threshold: -18, knee: 12, ratio: 6, attack: 0.002, release: 0.15 });
    master = new GainNode(ctx);
    master.connect(compressor).connect(ctx.destination);
    noise = makeNoise(ctx, "white");
    pink = makeNoise(ctx, "pink");
  }
  // Browsers start audio suspended until the page has had a click or key.
  if (resume && ctx.state === "suspended") void ctx.resume();
  master!.gain.value = sound.volume;
  return { ctx, master: master!, noise: noise!, pink: pink! };
}

const between = (min: number, max: number) => min + Math.random() * (max - min);
/** `x` give or take `spread` (a fraction). */
const vary = (x: number, spread: number) => x * between(1 - spread, 1 + spread);

/** A voice: a panned gain into the master, freed (and uncounted) after `seconds`. */
function voice(pan: number, seconds: number) {
  if (voices >= MAX_VOICES) return null;
  const { ctx, master, noise, pink } = audio();
  voices++;
  const out = new GainNode(ctx);
  out.connect(new StereoPannerNode(ctx, { pan })).connect(master);
  setTimeout(() => {
    voices--;
    out.disconnect();
  }, seconds * 1000 + 100);
  return { ctx, out, noise, pink, t: ctx.currentTime };
}

/** Stereo position from a letter's x in the scene (the view is ~7 units wide). */
export const panFor = (x: number) => Math.max(-1, Math.min(1, x / 4)) * 0.6;

/** One breath's level over `seconds`, the shape of the recording's
 *  inflations: fading in over `attack` to `startDb` below the peak, quickly
 *  halfway up (in dB) over the first 30% of the rise, then gradually to the
 *  peak at `peakAt`; easing down to `tailDb` until the release, then a
 *  rounded fade to silence over the last `release` of the length. */
function breathEnvelope(param: AudioParam, peak: number, t: number, seconds: number, startDb: number, peakAt: number, tailDb: number) {
  const db = (d: number) => Math.max(peak * 10 ** (d / 20), 0.0001);
  // Fade in from silence over `attack`, then the rise; each step after the last.
  const attack = Math.min(sound.inflate.attack, seconds * 0.5);
  // The knee sits 30% of the way through the rise that's left after the
  // fade-in, so a long fade-in doesn't squeeze it into a jump.
  const top = Math.max(seconds * peakAt, attack + 0.02);
  const knee = attack + (top - attack) * 0.3;
  // The release starts at the peak at the earliest.
  const fade = Math.max(seconds * (1 - sound.inflate.release), top);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(db(startDb), t + attack);
  param.exponentialRampToValueAtTime(db(startDb / 2), t + knee);
  param.exponentialRampToValueAtTime(db(0), t + top);
  let from = db(0);
  if (fade > top + 0.005) {
    param.exponentialRampToValueAtTime(db(tailDb), t + fade);
    from = db(tailDb);
  }
  // Rounded off: a half cosine, so it eases out of the level and into silence
  // with no corner at either end. (A tiny gap: a curve may not start at
  // another event's time.)
  if (seconds - fade > 0.01) param.setValueCurveAtTime(RELEASE_CURVE.map((v) => v * from), t + fade + 0.001, seconds - fade - 0.001);
  else param.linearRampToValueAtTime(0, t + seconds);
}
const RELEASE_CURVE = Float32Array.from({ length: 32 }, (_, i) => 0.5 + 0.5 * Math.cos((Math.PI * i) / 31));

/** A stretched membrane's first modes (frequency ratio, level), the ones
 *  found in the recording: 164, 264, 347, 506 and 861 Hz. */
const MEMBRANE_MODES: [number, number][] = [
  [1, 1],
  [1.59, 0.2],
  [2.14, 0.15],
  [3.16, 0.08],
  [5.25, 0.05],
];

/** A small room's echo: an impulse response of decaying, darkening noise,
 *  built once per audio context and length. */
const rooms = new WeakMap<BaseAudioContext, { length: number; ir: AudioBuffer }>();
function roomResponse(ctx: BaseAudioContext, length: number) {
  const cached = rooms.get(ctx);
  if (cached?.length === length) return cached.ir;
  const n = Math.max(1, Math.round(ctx.sampleRate * length));
  const ir = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const data = ir.getChannelData(0);
  let low = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Smoother than white, more so as it decays: a soft room whose highs
    // die off first.
    low += (Math.random() * 2 - 1 - low) * (0.25 - 0.2 * t);
    // 60 dB down by the end.
    data[i] = low * 10 ** (-3 * t);
  }
  // Unit energy, so roomLevel is the echo's level relative to the sound.
  let energy = 0;
  for (let i = 0; i < n; i++) energy += data[i]! ** 2;
  const scale = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < n; i++) data[i]! *= scale;
  rooms.set(ctx, { length, ir });
  return ir;
}

/** A balloon being blown up, into `out` at time `t`. */
/** The room's echo, shared: one convolver per audio context that every
 *  sound feeds, out to `to` (the master, or an offline render's
 *  destination). A convolver per sound prepared the echo again every time,
 *  about 1 ms a keystroke. Rebuilt if the panel changes its length. */
const roomBuses = new WeakMap<BaseAudioContext, { input: GainNode; level: GainNode; convolver: ConvolverNode | null; length: number }>();
function roomBus(ctx: BaseAudioContext, to: AudioNode) {
  let bus = roomBuses.get(ctx);
  if (!bus) {
    const level = new GainNode(ctx);
    level.connect(to);
    bus = { input: new GainNode(ctx), level, convolver: null, length: -1 };
    roomBuses.set(ctx, bus);
  }
  const p = sound.inflate;
  if (p.roomLength > 0 && bus.length !== p.roomLength) {
    bus.convolver?.disconnect();
    bus.input.disconnect();
    bus.convolver = new ConvolverNode(ctx, { buffer: roomResponse(ctx, p.roomLength), disableNormalization: true });
    bus.input.connect(bus.convolver).connect(bus.level);
    bus.length = p.roomLength;
  }
  bus.level.gain.value = p.roomLength > 0 ? p.roomLevel : 0;
  return bus.input;
}

function inflateInto(ctx: BaseAudioContext, dry: AudioNode, noise: AudioBuffer, t: number, seconds: number, room: AudioNode | null) {
  const p = sound.inflate;
  // Everything goes out directly and through the room.
  const out = new GainNode(ctx);
  out.connect(dry);
  if (room && p.roomLevel > 0) out.connect(room);
  const source = (into: AudioNode) => {
    const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    src.connect(into);
    src.start(t, Math.random() * 0.9);
    src.stop(t + seconds);
  };

  // The breath: noise band-limited like the recording, with its resonances.
  const chain = [
    new BiquadFilterNode(ctx, { type: "highpass", frequency: p.lowCut }),
    new BiquadFilterNode(ctx, { type: "lowpass", frequency: p.highCut }),
    new BiquadFilterNode(ctx, { type: "peaking", frequency: vary(p.peak1, p.variation), gain: p.peak1Boost, Q: p.peak1Q }),
    new BiquadFilterNode(ctx, { type: "peaking", frequency: vary(p.peak2, p.variation), gain: p.peak2Boost, Q: p.peak2Q }),
    new BiquadFilterNode(ctx, { type: "peaking", frequency: vary(p.peak3, p.variation), gain: p.peak3Boost, Q: p.peak3Q }),
  ];
  for (let i = 1; i < chain.length; i++) chain[i - 1]!.connect(chain[i]!);
  const breath = new GainNode(ctx, { gain: 0 });
  breathEnvelope(breath.gain, p.level * p.breathLevel, t, seconds, p.startDb, p.peakAt, p.tailDb);
  chain.at(-1)!.connect(breath).connect(out);
  source(chain[0]!);

  // Rumble: the low end (not the very lowest), building toward the end more
  // than the rest.
  const rumbleFilter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: p.rumbleCutoff });
  const rumble = new GainNode(ctx, { gain: 0 });
  breathEnvelope(rumble.gain, p.level * p.breathLevel * p.rumbleLevel, t, seconds, p.startDb * 2, Math.min(p.peakAt + 0.15, 0.85), p.tailDb);
  rumbleFilter.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 150 })).connect(rumble).connect(out);
  source(rumbleFilter);

  // Skin: the rubber vibrating in a stretched membrane's modes (ratios of
  // its first mode), driven by the breath, rising in pitch as it stretches
  // (cartoon-style) with a little wobble. The envelope is on the drive, not
  // the output, so the modes ring on after the breath stops.
  if (p.skinLevel > 0) {
    const drive = new GainNode(ctx, { gain: 0 });
    breathEnvelope(drive.gain, p.level * p.skinLevel, t, seconds, p.startDb * 2, p.skinPeakAt, p.tailDb);
    const driveFilter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1500 });
    driveFilter.connect(drive);
    const f0 = vary(p.skinPitch, p.variation);
    // One wobble for all the modes, so the whole skin bends together.
    const wobble = new GainNode(ctx, { gain: p.skinVibrato });
    const lfo = new OscillatorNode(ctx, { frequency: vary(p.skinVibratoRate, p.variation) });
    lfo.connect(wobble);
    lfo.start(t);
    lfo.stop(t + seconds + 0.4);
    for (const [ratio, weight] of MEMBRANE_MODES) {
      const mode = new BiquadFilterNode(ctx, { type: "bandpass", Q: p.skinQ });
      wobble.connect(mode.detune);
      mode.frequency.setValueAtTime(f0 * ratio, t);
      mode.frequency.exponentialRampToValueAtTime(f0 * ratio * p.skinGlide, t + seconds);
      // A narrow band passes little noise: make up for it, more for higher Q.
      drive.connect(mode).connect(new GainNode(ctx, { gain: weight * Math.sqrt(p.skinQ) })).connect(out);
    }
    source(driveFilter);
  }

  // Air: the faint top end above the breath's band.
  const airFilter = new BiquadFilterNode(ctx, { type: "highpass", frequency: 6000 });
  const air = new GainNode(ctx, { gain: 0 });
  breathEnvelope(air.gain, p.level * p.breathLevel * p.airLevel, t, seconds, p.startDb, p.peakAt, p.tailDb);
  airFilter.connect(air).connect(out);
  source(airFilter);
}

/** A balloon being blown up as a letter inflates. */
export function playInflate(pan: number) {
  const seconds = vary(sound.inflate.length, sound.inflate.variation);
  // Longer than the breath: the skin and the room ring on after it.
  const v = voice(pan, seconds + Math.max(0.3, sound.inflate.roomLength));
  if (v) inflateInto(v.ctx, v.out, v.pink, v.t, seconds, roomBus(v.ctx, audio().master));
}

/** A balloon popping `delay` seconds from now: a single bang, one burst of
 *  noise with nothing tonal in it (pitch sweeps made it sound like a laser),
 *  with a short boom after the hit so it doesn't sound like a knock on
 *  something solid. */
export function playPop(pan: number, delay = 0) {
  const tail = vary(sound.pop.length, sound.pop.variation);
  const v = voice(pan, delay + tail);
  if (v) popInto(v.ctx, v.out, v.noise, v.t + delay, tail);
}

/** The pop, into `out` at time `t`, lasting `tail` seconds. */
function popInto(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, t: number, tail: number) {
  const p = sound.pop;
  const lowCut = new BiquadFilterNode(ctx, { type: "highpass", frequency: p.lowCut });
  const highCut = new BiquadFilterNode(ctx, { type: "lowpass", Q: p.cutoffQ });
  highCut.frequency.setValueAtTime(vary(p.cutoffFrom, p.variation), t);
  highCut.frequency.exponentialRampToValueAtTime(p.cutoffTo, t + tail);
  // The hit, then the boom dying away.
  const gain = new GainNode(ctx, { gain: 0 });
  gain.gain.setValueAtTime(p.hitLevel, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(p.boomLevel, 0.001), t + Math.min(p.hitLength, tail * 0.9));
  gain.gain.exponentialRampToValueAtTime(0.001, t + tail);
  lowCut.connect(highCut).connect(gain).connect(out);
  const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
  src.connect(lowCut);
  src.start(t, Math.random() * 0.9);
  src.stop(t + tail);
}

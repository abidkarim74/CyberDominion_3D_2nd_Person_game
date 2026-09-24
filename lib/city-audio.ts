type SoundFrame = { speed: number; engineLoad: number; boosting: boolean; drifting: boolean; steering: number; reversing: boolean };

/** Procedural audio keeps the scene self contained; start() is called from the PLAY gesture. */
export class CityAudio {
  private context: AudioContext | null = null;
  private frame: SoundFrame = { speed: 0, engineLoad: .2, boosting: false, drifting: false, steering: 0, reversing: false };
  private readonly oscillators: OscillatorNode[] = [];
  private tick = 0;
  private nodes: AudioNode[] = [];
  private engineGain?: GainNode;
  private harmonicGain?: GainNode;
  private engineFilter?: BiquadFilterNode;
  private boostGain?: GainNode;
  private tireGain?: GainNode;
  private windGain?: GainNode;
  private windFilter?: BiquadFilterNode;
  private windPan?: StereoPannerNode;
  private levels = { engine: 0, rain: 0, wind: 0, city: 0, tire: 0, boost: 0 };

  start() {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      return;
    }
    try {
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      const master = context.createGain(); master.gain.value = .78;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -20; compressor.knee.value = 14; compressor.ratio.value = 8;
      compressor.attack.value = .004; compressor.release.value = .18;
      master.connect(compressor); compressor.connect(context.destination);

      const engineFilter = context.createBiquadFilter(); engineFilter.type = 'lowpass'; engineFilter.frequency.value = 620;
      const engineGain = context.createGain(); engineGain.gain.value = .025;
      this.engineGain = engineGain; this.engineFilter = engineFilter;
      engineFilter.connect(engineGain); engineGain.connect(master);
      const saw = context.createOscillator(); saw.type = 'sawtooth'; saw.frequency.value = 49;
      const undertone = context.createOscillator(); undertone.type = 'triangle'; undertone.frequency.value = 24.5;
      const engineHarmonic = context.createOscillator(); engineHarmonic.type = 'square'; engineHarmonic.frequency.value = 73.5;
      const harmonicGain = context.createGain(); harmonicGain.gain.value = .12;
      this.harmonicGain = harmonicGain;
      saw.connect(engineFilter); undertone.connect(engineFilter); engineHarmonic.connect(harmonicGain); harmonicGain.connect(engineFilter);
      this.oscillators.push(saw, undertone, engineHarmonic);

      const boostOsc = context.createOscillator(); boostOsc.type = 'sawtooth'; boostOsc.frequency.value = 92;
      const boostFilter = context.createBiquadFilter(); boostFilter.type = 'bandpass'; boostFilter.frequency.value = 380; boostFilter.Q.value = .65;
      const boostGain = context.createGain(); boostGain.gain.value = .0001;
      this.boostGain = boostGain;
      boostOsc.connect(boostFilter); boostFilter.connect(boostGain); boostGain.connect(master);
      this.oscillators.push(boostOsc);

      const tireOsc = context.createOscillator(); tireOsc.type = 'sawtooth'; tireOsc.frequency.value = 520;
      const tireFilter = context.createBiquadFilter(); tireFilter.type = 'bandpass'; tireFilter.frequency.value = 800; tireFilter.Q.value = 3.5;
      const tireGain = context.createGain(); tireGain.gain.value = .0001;
      this.tireGain = tireGain;
      tireOsc.connect(tireFilter); tireFilter.connect(tireGain); tireGain.connect(master);
      this.oscillators.push(tireOsc);

      const rainFilter = context.createBiquadFilter(); rainFilter.type = 'lowpass'; rainFilter.frequency.value = 1250; rainFilter.Q.value = .35;
      const rainGain = context.createGain(); rainGain.gain.value = .074;
      const rainPan = context.createStereoPanner(); rainPan.pan.value = -.08;
      this.noise(context, rainFilter, rainGain, rainPan, 2.4);
      rainPan.connect(master);

      const windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 700;
      const windGain = context.createGain(); windGain.gain.value = .008;
      const windPan = context.createStereoPanner();
      this.windGain = windGain; this.windFilter = windFilter; this.windPan = windPan;
      this.noise(context, windFilter, windGain, windPan, .7);
      windPan.connect(master);

      const cityBand = context.createBiquadFilter(); cityBand.type = 'bandpass'; cityBand.frequency.value = 235; cityBand.Q.value = .52;
      const cityGain = context.createGain(); cityGain.gain.value = .012;
      const cityPan = context.createStereoPanner(); cityPan.pan.value = .06;
      this.noise(context, cityBand, cityGain, cityPan, 1.8);
      cityPan.connect(master);

      const droneA = context.createOscillator(); droneA.type = 'sine'; droneA.frequency.value = 53;
      const droneB = context.createOscillator(); droneB.type = 'sine'; droneB.frequency.value = 79;
      const droneGain = context.createGain(); droneGain.gain.value = .008;
      droneA.connect(droneGain); droneB.connect(droneGain); droneGain.connect(master);
      this.oscillators.push(droneA, droneB);
      this.nodes.push(master, compressor, engineFilter, engineGain, harmonicGain, boostFilter, boostGain,
        tireFilter, tireGain, rainFilter, rainGain, rainPan, windFilter, windGain, windPan,
        cityBand, cityGain, cityPan, droneGain);
      this.oscillators.forEach(oscillator => oscillator.start());
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch {
      // Audio remains optional on browsers or devices without Web Audio support.
      this.context = null;
    }
  }

  private noise(context: AudioContext, filter: BiquadFilterNode, gain: GainNode, pan: StereoPannerNode, seconds: number) {
    const length = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      smooth = smooth * .88 + white * .12;
      data[i] = smooth * .7 + white * .3;
    }
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
    source.connect(filter); filter.connect(gain); gain.connect(pan); source.start();
    this.nodes.push(source);
  }

  update(frame: SoundFrame) {
    this.frame = frame;
    const context = this.context;
    if (!context || context.state !== 'running') return;
    this.tick += 1;
    if (this.tick % 3 !== 0) return;
    const t = context.currentTime, s = Math.min(frame.speed / 83, 1), load = Math.max(frame.engineLoad, .16);
    const set = (param: AudioParam, value: number, smoothing = .075) => param.setTargetAtTime(value, t, smoothing);
    const oscillator = this.oscillators;
    const rpm = (frame.reversing ? 39 : 49) + s * 155 + load * 54 + (frame.boosting ? 32 : 0);
    set(oscillator[0].frequency, rpm); set(oscillator[1].frequency, rpm * .5); set(oscillator[2].frequency, rpm * 1.5);
    if (this.harmonicGain) set(this.harmonicGain.gain, .1 + load * .05);
    if (this.engineGain) set(this.engineGain.gain, .021 + load * .055 + s * .023);
    if (this.engineFilter) set(this.engineFilter.frequency, 530 + load * 470 + s * 480);
    if (this.boostGain) set(this.boostGain.gain, frame.boosting ? .075 : .0001, .045);
    set(oscillator[4].frequency, 390 + s * 180);
    if (this.tireGain) set(this.tireGain.gain, frame.drifting ? .032 + s * .045 : .0001, .1);
    if (this.windGain) set(this.windGain.gain, .006 + s * s * .082);
    if (this.windFilter) set(this.windFilter.frequency, 460 + s * 1320);
    if (this.windPan) set(this.windPan.pan, THREEClamp(frame.steering * .25));
    this.levels = { engine: .021 + load * .055 + s * .023, rain: .074, wind: .006 + s * s * .082,
      city: .012, tire: frame.drifting ? .032 + s * .045 : 0, boost: frame.boosting ? .075 : 0 };
  }

  diagnostics() {
    return { state: this.context?.state ?? 'not-started', levels: { ...this.levels },
      engineFrequency: this.oscillators[0]?.frequency.value ?? 0, frame: { ...this.frame } };
  }

  dispose() {
    if (!this.context) return;
    const context = this.context;
    this.oscillators.forEach(oscillator => { try { oscillator.stop(); } catch { /* already stopped */ } });
    this.nodes.forEach(node => { try { node.disconnect(); } catch { /* already disconnected */ } });
    this.oscillators.forEach(node => { try { node.disconnect(); } catch { /* already disconnected */ } });
    this.nodes.length = 0; this.oscillators.length = 0; this.context = null;
    void context.close().catch(() => {});
  }

}

function THREEClamp(value: number) { return Math.max(-1, Math.min(1, value)); }

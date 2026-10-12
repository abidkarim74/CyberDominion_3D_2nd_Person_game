type SoundFrame = { speed: number; engineLoad: number; boosting: boolean; drifting: boolean; tireSqueal: number; steering: number; reversing: boolean };

/** Procedural audio keeps the scene self contained; start() is called from the PLAY gesture. */
export class CityAudio {
  private context: AudioContext | null = null;
  private frame: SoundFrame = { speed: 0, engineLoad: .2, boosting: false, drifting: false, tireSqueal: 0, steering: 0, reversing: false };
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
  private gunMaster?: GainNode;
  private minigunSource?: AudioBufferSourceNode;
  private minigunGain?: GainNode;
  private minigunFilter?: BiquadFilterNode;
  private minigunSpinOsc?: OscillatorNode;
  private minigunSpinGain?: GainNode;
  private minigunActive = false;
  private minigunSpinUp = 0;
  private gunTone?: BiquadFilterNode;
  private output?: DynamicsCompressorNode;
  private levels = { engine: 0, snow: 0, wind: 0, city: 0, tire: 0, boost: 0 };

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
      master.connect(compressor); compressor.connect(context.destination); this.output = compressor;

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
      const tireScrubFilter = context.createBiquadFilter(); tireScrubFilter.type = 'bandpass'; tireScrubFilter.frequency.value = 1400; tireScrubFilter.Q.value = .7;
      const tireScrubGain = context.createGain(); tireScrubGain.gain.value = .8;
      this.noise(context, tireScrubFilter, tireScrubGain, tireGain, .8);

      const snowFilter = context.createBiquadFilter(); snowFilter.type = 'lowpass'; snowFilter.frequency.value = 550; snowFilter.Q.value = .35;
      const snowGain = context.createGain(); snowGain.gain.value = .018;
      const snowPan = context.createStereoPanner(); snowPan.pan.value = -.08;
      this.noise(context, snowFilter, snowGain, snowPan, 2.4);
      snowPan.connect(master);

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
      // Stereo weapon bus: body, crack, action chatter, and a short street reflection.
      const gunMasterGain = context.createGain(); gunMasterGain.gain.value = .84;
      const gunTone = context.createBiquadFilter(); gunTone.type = 'lowpass';
      gunTone.frequency.value = 4200; gunTone.Q.value = .45;
      const gunHighpass = context.createBiquadFilter(); gunHighpass.type = 'highpass'; gunHighpass.frequency.value = 65;
      gunMasterGain.connect(gunHighpass); gunHighpass.connect(gunTone); gunTone.connect(master);
      this.gunMaster = gunMasterGain; this.gunTone = gunTone;
      const reflection = context.createDelay(.3); reflection.delayTime.value = .115;
      const reflectionFilter = context.createBiquadFilter(); reflectionFilter.type = 'lowpass'; reflectionFilter.frequency.value = 1600;
      const reflectionGain = context.createGain(); reflectionGain.gain.value = .16;
      gunTone.connect(reflection); reflection.connect(reflectionFilter); reflectionFilter.connect(reflectionGain); reflectionGain.connect(master);

      const minigunLen = context.sampleRate * 2;
      const minigunBuf = context.createBuffer(2, minigunLen, context.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = minigunBuf.getChannelData(channel);
        let pink = 0;
        for (let i = 0; i < minigunLen; i++) {
          const time = i / context.sampleRate;
          // Offset the second gun by half a cycle. Each delivers 48 distinct shots/s.
          const age = ((time * 48 + channel * .5) % 1) / 48;
          const otherAge = ((time * 48 + (1 - channel) * .5) % 1) / 48;
          const noise = Math.random() * 2 - 1; pink = pink * .8 + noise * .2;
          const attack = Math.min(1, age / .00035);
          const crack = (noise * .66 + pink * .34) * Math.exp(-age / .0085) * attack;
          const body = Math.sin(age * Math.PI * 2 * 125) * Math.exp(-age / .018) * .42;
          const action = Math.sin(age * Math.PI * 2 * 1850) * Math.exp(-Math.abs(age - .004) / .0016) * .10;
          const otherGun = noise * Math.exp(-otherAge / .0085) * .22 + Math.sin(otherAge * Math.PI * 2 * 140) * Math.exp(-otherAge / .018) * .12;
          data[i] = (crack + body + action + otherGun) * .78;
        }
      }
      const minigunSource = context.createBufferSource(); minigunSource.buffer = minigunBuf; minigunSource.loop = true;
      const minigunFilter = context.createBiquadFilter(); minigunFilter.type = 'highpass'; minigunFilter.frequency.value = 75;
      const minigunGain = context.createGain(); minigunGain.gain.value = 0;
      minigunSource.connect(minigunFilter); minigunFilter.connect(minigunGain); minigunGain.connect(gunMasterGain);
      minigunSource.start(); this.minigunSource = minigunSource; this.minigunGain = minigunGain; this.minigunFilter = minigunFilter;
      const spinOsc = context.createOscillator(); spinOsc.type = 'triangle'; spinOsc.frequency.value = 65;
      const spinGain = context.createGain(); spinGain.gain.value = 0;
      const spinFilter = context.createBiquadFilter(); spinFilter.type = 'bandpass'; spinFilter.frequency.value = 480; spinFilter.Q.value = .7;
      spinOsc.connect(spinFilter); spinFilter.connect(spinGain); spinGain.connect(gunMasterGain); spinOsc.start();
      this.minigunSpinOsc = spinOsc; this.minigunSpinGain = spinGain;
      this.nodes.push(minigunSource, minigunFilter, minigunGain, spinOsc, spinFilter, spinGain,
        gunHighpass, reflection, reflectionFilter, reflectionGain);

      this.nodes.push(master, compressor, engineFilter, engineGain, harmonicGain, boostFilter, boostGain,
        tireFilter, tireGain, tireScrubFilter, tireScrubGain, snowFilter, snowGain, snowPan, windFilter, windGain, windPan,
        cityBand, cityGain, cityPan, droneGain, gunMasterGain, gunTone);
      this.oscillators.forEach(oscillator => oscillator.start());
      if (context.state === 'suspended') void context.resume().catch(() => {});
    } catch {
      // Audio remains optional on browsers or devices without Web Audio support.
      this.context = null;
    }
  }

  private noise(context: AudioContext, filter: BiquadFilterNode, gain: GainNode, output: AudioNode, seconds: number) {
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
    source.connect(filter); filter.connect(gain); gain.connect(output); source.start();
    this.nodes.push(source);
  }

  /** Firing rate and motor pitch follow the visible rotor's simulated speed. */
  fireGun(spin = 1) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    this.minigunActive = true; this.minigunSpinUp = Math.max(0, Math.min(1, spin));
    const firing = this.minigunSpinUp >= .18;
    this.minigunSource?.playbackRate.setTargetAtTime(Math.max(.18, this.minigunSpinUp), ctx.currentTime, .012);
    this.minigunGain?.gain.setTargetAtTime(firing ? .92 * this.minigunSpinUp : 0, ctx.currentTime, .012);
  }

  updateGunSpin(spin: number) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    this.minigunSpinOsc?.frequency.setTargetAtTime(65 + 330 * spin, ctx.currentTime, .025);
    this.minigunSpinGain?.gain.setTargetAtTime(.045 * spin, ctx.currentTime, .025);
  }

  stopFiring() {
    if (!this.minigunActive) return;
    this.minigunActive = false; this.minigunSpinUp = 0;
    const ctx = this.context;
    if (!ctx) return;
    this.minigunGain?.gain.setTargetAtTime(0, ctx.currentTime, .012);
    this.updateGunSpin(0);
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
    set(oscillator[4].frequency, 560 + s * 280 + frame.tireSqueal * 120);
    const tireLevel = Math.max(0, Math.min(1, frame.tireSqueal)) * (.038 + s * .07);
    if (this.tireGain) set(this.tireGain.gain, Math.max(.0001, tireLevel), tireLevel > 0 ? .045 : .09);
    if (this.windGain) set(this.windGain.gain, .006 + s * s * .082);
    if (this.windFilter) set(this.windFilter.frequency, 460 + s * 1320);
    if (this.windPan) set(this.windPan.pan, THREEClamp(frame.steering * .25));
    this.levels = { engine: .021 + load * .055 + s * .023, snow: .018, wind: .006 + s * s * .082,
      city: .012, tire: tireLevel, boost: frame.boosting ? .075 : 0 };
  }

  diagnostics() {
    return { state: this.context?.state ?? 'not-started', levels: { ...this.levels },
      gun: { active: this.minigunActive, gain: this.gunMaster?.gain.value ?? 0, cutoff: this.gunTone?.frequency.value ?? 0, spin: this.minigunSpinUp, rattle: this.minigunGain?.gain.value ?? 0 },
      outputReductionDb: this.output?.reduction ?? 0,
      engineFrequency: this.oscillators[0]?.frequency.value ?? 0, frame: { ...this.frame } };
  }

  dispose() {
    if (!this.context) return;
    const context = this.context;
    if (this.minigunSpinOsc) { try { this.minigunSpinOsc.stop(); } catch { /* already stopped */ } }
    this.oscillators.forEach(oscillator => { try { oscillator.stop(); } catch { /* already stopped */ } });
    this.nodes.forEach(node => { try { node.disconnect(); } catch { /* already disconnected */ } });
    this.oscillators.forEach(node => { try { node.disconnect(); } catch { /* already disconnected */ } });
    this.nodes.length = 0; this.oscillators.length = 0; this.context = null;
    void context.close().catch(() => {});
  }

}

function THREEClamp(value: number) { return Math.max(-1, Math.min(1, value)); }

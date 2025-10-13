const MIN_RESISTANCE = 0.1;
const MIN_CAPACITANCE = 1e-9;
const DEFAULT_TIME_STEP = 1 / 60;
const MAX_WAVEFORM_SAMPLES = 512;
const DEFAULT_WAVEFORM_INTERVAL = 1 / 240;

export class CodexSpice {
  constructor() {
    this.components = [];
    this.state = {
      capacitorVoltage: 0,
      time: 0,
    };
    this.outputs = {
      componentLines: new Map(),
      wireCurrents: [],
      busCurrent: 0,
      railVoltage: 0,
      sourceVoltage: 5,
    };
    this.cached = {
      totalResistance: MIN_RESISTANCE,
      totalCapacitance: 0,
      totalLedDrop: 0,
      sourceVoltage: 5,
    };
    this.constants = {
      rippleAmplitude: 0.6,
      rippleFrequency: 1.8,
      noiseAmplitude: 0.004,
    };
    this.waveform = [];
    this.waveTimer = 0;
    this.waveformInterval = DEFAULT_WAVEFORM_INTERVAL;
  }

  configure(model) {
    this.components = Array.isArray(model?.components) ? model.components : [];
    this.recalculateConstants();
    this.resetOutputs();
    this.state.capacitorVoltage = clamp(this.state.capacitorVoltage, 0, this.cached.sourceVoltage);
    this.waveform.length = 0;
    this.waveTimer = 0;
  }

  recalculateConstants() {
    const source = this.components.find(component => component.type === 'source');
    this.cached.sourceVoltage = source?.value ?? 5;

    const resistors = this.components.filter(component => component.type === 'resistor');
    const capacitors = this.components.filter(component => component.type === 'capacitor');
    const leds = this.components.filter(component => component.type === 'led');

    this.cached.totalResistance = Math.max(
      resistors.reduce((acc, item) => acc + Math.max(item.value ?? 0, 0), 0),
      MIN_RESISTANCE,
    );

    this.cached.totalCapacitance =
      capacitors.reduce((acc, item) => acc + Math.max(item.value ?? 0, 0), 0) * 1e-6;

    this.cached.totalLedDrop = leds.reduce((acc, item) => acc + Math.max(item.value ?? 0, 0), 0);
  }

  resetOutputs() {
    this.outputs.componentLines.clear();
    this.outputs.wireCurrents = [];
    this.outputs.busCurrent = 0;
    this.outputs.railVoltage = 0;
    this.outputs.sourceVoltage = this.cached.sourceVoltage;
  }

  update(dt = DEFAULT_TIME_STEP) {
    if (!Number.isFinite(dt) || dt <= 0) {
      dt = DEFAULT_TIME_STEP;
    }

    this.state.time += dt;

    const rippleSpan = Math.min(this.constants.rippleAmplitude, this.cached.sourceVoltage * 0.6);
    const ripple = rippleSpan * Math.sin(this.state.time * Math.PI * 2 * this.constants.rippleFrequency);
    const Vs = Math.max(this.cached.sourceVoltage + ripple, 0);
    const baseAvailableVoltage = Math.max(Vs - this.cached.totalLedDrop, 0);

    const totalCap = this.cached.totalCapacitance;
    const tau = totalCap > 0 ? this.cached.totalResistance * totalCap : 0;
    const previousCapVoltage = this.state.capacitorVoltage;

    let capacitorVoltage = baseAvailableVoltage;
    let capacitorCurrent = 0;

    if (totalCap > 0 && tau > 0) {
      const targetVoltage = baseAvailableVoltage;
      const difference = targetVoltage - previousCapVoltage;
      const dVdt = difference / tau;
      capacitorVoltage = previousCapVoltage + dVdt * dt;
      capacitorVoltage = clamp(capacitorVoltage, 0, baseAvailableVoltage);
      capacitorCurrent = (capacitorVoltage - previousCapVoltage) * totalCap / dt;
    }

    this.state.capacitorVoltage = capacitorVoltage;

    const effectiveVoltage = clamp(capacitorVoltage, 0, baseAvailableVoltage);
    const loadCurrent = this.cached.totalResistance > 0 ? effectiveVoltage / this.cached.totalResistance : 0;
    const currentMilli = clamp(loadCurrent * 1000, 0, 1e6);

    this.outputs.busCurrent = loadCurrent;
    this.outputs.railVoltage = effectiveVoltage;
    this.outputs.sourceVoltage = Vs;

    this.populateComponentLines({
      loadCurrent,
      currentMilli,
      capacitorVoltage,
      capacitorCurrent,
      effectiveVoltage,
      sourceVoltage: Vs,
    });

    this.populateWireCurrents(loadCurrent);

    this.waveTimer += dt;
    while (this.waveTimer >= this.waveformInterval) {
      this.appendWaveSample(this.outputs.busCurrent ?? 0);
      this.waveTimer -= this.waveformInterval;
    }
  }

  populateComponentLines(context) {
    const {
      loadCurrent,
      currentMilli,
      capacitorVoltage,
      capacitorCurrent,
      effectiveVoltage,
      sourceVoltage,
    } = context;

    this.outputs.componentLines.clear();

    this.components.forEach(component => {
      switch (component.type) {
        case 'source': {
          const ripple = sourceVoltage - this.cached.sourceVoltage;
          this.outputs.componentLines.set(component.id, [
            `Output: ${sourceVoltage.toFixed(3)} V`,
            `Series current: ${currentMilli.toFixed(2)} mA`,
            `Ripple offset: ${(ripple >= 0 ? '+' : '') + ripple.toFixed(3)} V`,
          ]);
          break;
        }
        case 'resistor': {
          const resistance = clamp(component.value ?? 0, MIN_RESISTANCE, 1e6);
          const drop = loadCurrent * resistance;
          const power = loadCurrent * loadCurrent * resistance;
          this.outputs.componentLines.set(component.id, [
            `Resistance: ${resistance.toFixed(0)} Ω`,
            `Voltage drop: ${drop.toFixed(3)} V`,
            `Power dissipation: ${(power * 1000).toFixed(2)} mW`,
          ]);
          break;
        }
        case 'capacitor': {
          const capValue = component.value ?? 0;
          this.outputs.componentLines.set(component.id, [
            `Node voltage: ${capacitorVoltage.toFixed(3)} V`,
            `Charge current: ${(capacitorCurrent * 1000).toFixed(2)} mA`,
            `Capacitance: ${capValue.toFixed(0)} µF`,
          ]);
          break;
        }
        case 'led': {
          const forwardVoltage = component.value ?? 0;
          const brightness = clamp((loadCurrent * 1000) / 20, 0, 2);
          this.outputs.componentLines.set(component.id, [
            `Forward current: ${currentMilli.toFixed(2)} mA`,
            `Forward voltage: ${forwardVoltage.toFixed(3)} V`,
            `Relative brightness: ${(brightness * 100).toFixed(0)} %`,
          ]);
          break;
        }
        default:
          this.outputs.componentLines.set(component.id, [
            component.value !== undefined ? `Value: ${formatValue(component)}` : 'No simulation data.',
            'Advanced solver integration coming soon.',
          ]);
      }
    });
  }

  populateWireCurrents(loadCurrent) {
    const magnitude = Math.abs(loadCurrent);
    const direction = Math.sign(loadCurrent) || 1;
    this.outputs.wireCurrents = this.components.slice(0, -1).map(() => ({
      current: loadCurrent,
      magnitude,
      direction,
    }));
    this.outputs.wireCurrents.push({
      current: -loadCurrent,
      magnitude,
      direction: -direction,
    });
  }

  getComponentLines(id) {
    return this.outputs.componentLines.get(id) ?? ['No simulation data.'];
  }

  getWireData(index) {
    return this.outputs.wireCurrents[index] ?? { current: 0, magnitude: 0, direction: 1 };
  }

  getNormalizedValue(metric) {
    switch (metric) {
      case 'ledBrightness':
        return clamp(Math.abs(this.outputs.busCurrent) * 1000 / 20, 0, 2);
      case 'capacitorCharge':
        return clamp(
          this.state.capacitorVoltage / Math.max(this.cached.sourceVoltage, 0.001),
          0,
          1.4,
        );
      case 'resistorPower':
        return clamp(
          (this.outputs.busCurrent * this.outputs.busCurrent * this.cached.totalResistance) / 0.25,
          0,
          2,
        );
      default:
        return 0;
    }
  }

  getLiveStats() {
    return {
      sourceVoltage: this.outputs.sourceVoltage ?? this.cached.sourceVoltage,
      railVoltage: this.outputs.railVoltage ?? 0,
      busCurrent: this.outputs.busCurrent ?? 0,
    };
  }

  getWaveformSamples(count) {
    if (!this.waveform.length) {
      return new Array(count).fill(0);
    }
    if (!count || count >= this.waveform.length) {
      return [...this.waveform];
    }
    return this.waveform.slice(this.waveform.length - count);
  }

  appendWaveSample(current) {
    const noisy = current + (Math.random() - 0.5) * this.constants.noiseAmplitude;
    this.waveform.push(noisy);
    if (this.waveform.length > MAX_WAVEFORM_SAMPLES) {
      this.waveform.shift();
    }
  }
}

export class SimulationManager {
  constructor(onStatusChange = () => {}) {
    this.series = new CodexSpice();
    this.onStatusChange = onStatusChange;
    this.notify();
  }

  configure(model) {
    this.series.configure(model);
    this.notify();
  }

  update(dt) {
    this.series.update(dt);
  }

  getComponentLines(id) {
    return this.series.getComponentLines(id);
  }

  getWireData(index) {
    return this.series.getWireData(index);
  }

  getNormalizedValue(metric) {
    return this.series.getNormalizedValue(metric);
  }

  getLiveStats() {
    return this.series.getLiveStats();
  }

  getWaveformSamples(count) {
    return this.series.getWaveformSamples(count);
  }

  getStatus() {
    return {
      usingEEC: false,
      error: null,
    };
  }

  notify() {
    this.onStatusChange?.(this.getStatus());
  }
}

function formatValue(component) {
  switch (component.type) {
    case 'resistor':
      return `${component.value?.toFixed(0) ?? '—'} Ω`;
    case 'capacitor':
      return `${component.value?.toFixed(0) ?? '—'} µF`;
    case 'led':
      return `${component.value?.toFixed(2) ?? '—'} V`;
    default:
      return `${component.value ?? '—'}`;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

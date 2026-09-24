/**
 * A deterministic teaching model, not an engine performance / CFD solver.
 * Length: mm; volume: cm³; pressure: bar absolute; temperature: kelvin.
 * 0° is intake TDC. A complete thermodynamic cycle spans 720°.
 */
export const ENGINE = Object.freeze({
  bore: 86,
  stroke: 90,
  rodLength: 150,
  compressionRatio: 18,
  cutoffRatio: 2.2,
  gamma: 1.35,
  ambientPressure: 1.01325,
  ambientTemperature: 300,
});

export const STROKES = Object.freeze([
  Object.freeze({
    id: 'intake', name: '进气', english: 'INTAKE', color: '#55cbdc',
    start: 0, end: 180, preview: 90, direction: '下行',
    title: '让新鲜空气进入气缸',
    description: '进气门打开，活塞向下运动，将新鲜空气吸入气缸。此时只吸入空气，不与柴油预混。',
    energy: '曲轴带动活塞 · 吸入空气',
  }),
  Object.freeze({
    id: 'compression', name: '压缩', english: 'COMPRESSION', color: '#b3a0f3',
    start: 180, end: 360, preview: 300, direction: '上行',
    title: '压缩空气，使温度升高',
    description: '两只气门关闭，活塞向上压缩空气。压力与温度随之升高；接近上止点时开始喷油。',
    energy: '机械能 → 气体内能',
  }),
  Object.freeze({
    id: 'power', name: '做功', english: 'POWER', color: '#f5ad66',
    start: 360, end: 540, preview: 395, direction: '下行',
    title: '柴油压燃，推动活塞做功',
    description: '雾化柴油进入高温空气后自行着火。燃气膨胀，推动活塞、连杆和曲轴输出机械功。',
    energy: '燃料化学能 → 机械能',
  }),
  Object.freeze({
    id: 'exhaust', name: '排气', english: 'EXHAUST', color: '#96a7b8',
    start: 540, end: 720, preview: 630, direction: '上行',
    title: '排出废气，准备下一循环',
    description: '排气门打开，活塞向上运动，将燃烧后的废气推出气缸。曲轴转完两圈，完成一次循环。',
    energy: '曲轴带动活塞 · 排出废气',
  }),
]);

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

export function normalizeAngle(angle) {
  requireFinite(angle, 'angle');
  return ((angle % 720) + 720) % 720;
}

export function validateEngine(engine) {
  for (const [key, value] of Object.entries(ENGINE)) {
    requireFinite(engine[key] ?? Number.NaN, key);
    if (engine[key] <= 0) throw new RangeError(`${key} must be positive`);
  }
  if (engine.rodLength <= engine.stroke / 2) {
    throw new RangeError('connecting rod must be longer than crank radius');
  }
  if (engine.compressionRatio <= 1 || engine.gamma <= 1) {
    throw new RangeError('compression ratio and gamma must exceed one');
  }
  if (engine.cutoffRatio <= 1 || engine.cutoffRatio >= engine.compressionRatio) {
    throw new RangeError('cutoff ratio must lie between one and compression ratio');
  }
  return engine;
}

export function getGeometry(angle, engine = ENGINE) {
  validateEngine(engine);
  const radians = normalizeAngle(angle) * Math.PI / 180;
  const radius = engine.stroke / 2;
  const crankX = radius * Math.sin(radians);
  const crankY = radius * Math.cos(radians);
  const pistonY = crankY + Math.sqrt(engine.rodLength ** 2 - crankX ** 2);
  const displacement = Math.max(0, Math.min(engine.stroke, radius + engine.rodLength - pistonY));
  const sweptVolume = Math.PI * (engine.bore / 2) ** 2 * engine.stroke / 1000;
  const clearanceVolume = sweptVolume / (engine.compressionRatio - 1);
  const volume = clearanceVolume + sweptVolume * displacement / engine.stroke;
  return { radians, crankX, crankY, pistonY, displacement, volume, sweptVolume, clearanceVolume };
}

function valveLift(angle, start, end) {
  if (angle <= start || angle >= end) return 0;
  return 7 * Math.sin(Math.PI * (angle - start) / (end - start)) ** 1.5;
}

export function getEngineState(angle, engine = ENGINE) {
  const cycleAngle = normalizeAngle(angle);
  const geometry = getGeometry(cycleAngle, engine);
  const strokeIndex = Math.floor(cycleAngle / 180);
  const stroke = STROKES[strokeIndex];
  const progress = (cycleAngle - stroke.start) / 180;
  const { volume, clearanceVolume, sweptVolume } = geometry;
  const maxVolume = clearanceVolume + sweptVolume;
  const p1 = engine.ambientPressure;
  const t1 = engine.ambientTemperature;
  const p2 = p1 * engine.compressionRatio ** engine.gamma;
  const t2 = t1 * engine.compressionRatio ** (engine.gamma - 1);
  const cutoffVolume = clearanceVolume * engine.cutoffRatio;
  let pressureBar;
  let temperatureK;

  if (strokeIndex === 0) {
    pressureBar = p1 * (1 - 0.025 * Math.sin(progress * Math.PI));
    temperatureK = t1;
  } else if (strokeIndex === 1) {
    pressureBar = p1 * (maxVolume / volume) ** engine.gamma;
    temperatureK = t1 * (maxVolume / volume) ** (engine.gamma - 1);
  } else if (strokeIndex === 2) {
    if (volume <= cutoffVolume) {
      // Ideal Diesel-cycle constant-pressure heat addition.
      pressureBar = p2;
      temperatureK = t2 * volume / clearanceVolume;
    } else {
      pressureBar = p2 * (cutoffVolume / volume) ** engine.gamma;
      temperatureK = t2 * engine.cutoffRatio * (cutoffVolume / volume) ** (engine.gamma - 1);
    }
  } else {
    // Blowdown at BDC is intentionally idealized as instantaneous.
    pressureBar = p1 * (1 + 0.04 * Math.sin(progress * Math.PI));
    const expansionEndTemperature = t2 * engine.cutoffRatio
      * (cutoffVolume / maxVolume) ** (engine.gamma - 1);
    temperatureK = expansionEndTemperature * (1 - 0.3 * progress);
  }

  const injection = cycleAngle >= 350 && cycleAngle < 388
    ? Math.sin(Math.PI * (cycleAngle - 350) / 38) : 0;
  const combustion = strokeIndex === 2
    ? Math.max(0, 1 - (cycleAngle - 360) / 115) : 0;
  const intakeLift = valveLift(cycleAngle, 0, 180);
  const exhaustLift = valveLift(cycleAngle, 540, 720);
  const deadCenter = Math.abs(Math.sin(geometry.radians)) < 1e-9;

  return {
    ...geometry, angle: cycleAngle, strokeIndex, stroke, progress,
    pressureBar, temperatureK, intakeLift, exhaustLift, injection, combustion,
    direction: deadCenter ? '止点' : stroke.direction,
  };
}

/** 1× playback is 1/60 real time: 1200 rpm is displayed at 20 rpm. */
export function advanceAngle(angle, elapsedSeconds, rpm = 1200, playbackRate = 1) {
  for (const [name, value] of Object.entries({ elapsedSeconds, rpm, playbackRate })) {
    requireFinite(value, name);
    if (value < 0) throw new RangeError(`${name} must not be negative`);
  }
  // Never leap ahead when a suspended tab resumes.
  const delta = Math.min(elapsedSeconds, 0.1);
  return normalizeAngle(angle + delta * rpm * 6 * playbackRate / 60);
}

export function sampleCycle(step = 2, engine = ENGINE) {
  requireFinite(step, 'step');
  if (step < 0.25 || step > 180) throw new RangeError('step must be in [0.25, 180]');
  const samples = [];
  for (let angle = 0; angle < 720; angle += step) samples.push(getEngineState(angle, engine));
  samples.push(getEngineState(720 - 1e-7, engine));
  return samples;
}
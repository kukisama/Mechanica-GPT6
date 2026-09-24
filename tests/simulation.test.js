import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, STROKES, advanceAngle, getEngineState, getGeometry, normalizeAngle, sampleCycle, validateEngine } from '../src/simulation.js';

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('angle normalization handles both revolutions, negative input and large angles', () => {
  for (const [input, output] of [[0, 0], [360, 360], [720, 0], [1440, 0], [-10, 710], [-720, 0], [720001, 1]]) near(normalizeAngle(input), output);
  for (const angle of [NaN, Infinity, -Infinity, '90', null]) assert.throws(() => normalizeAngle(angle), TypeError);
});

test('four strokes have precise non-overlapping 180-degree boundaries', () => {
  for (const [angle, index] of [[0, 0], [179.999, 0], [180, 1], [359.999, 1], [360, 2], [539.999, 2], [540, 3], [719.999, 3], [720, 0]]) {
    assert.equal(getEngineState(angle).strokeIndex, index);
  }
  STROKES.forEach((stroke, index) => assert.equal(getEngineState(stroke.preview).strokeIndex, index));
});

test('piston reaches both dead centers with the specified stroke', () => {
  for (const angle of [0, 360, 720]) {
    near(getGeometry(angle).displacement, 0);
    near(getGeometry(angle).pistonY, ENGINE.rodLength + ENGINE.stroke / 2);
    assert.equal(getEngineState(angle).direction, '止点');
  }
  for (const angle of [180, 540]) {
    near(getGeometry(angle).displacement, ENGINE.stroke);
    near(getGeometry(angle).pistonY, ENGINE.rodLength - ENGINE.stroke / 2);
  }
});

test('connecting rod stays exactly 150 mm long at every angle', () => {
  for (let angle = 0; angle < 720; angle += 0.25) {
    const g = getGeometry(angle);
    near(Math.hypot(g.crankX, g.pistonY - g.crankY), ENGINE.rodLength);
    near(Math.hypot(g.crankX, g.crankY), ENGINE.stroke / 2);
  }
});

test('motion repeats every 360 degrees but combustion repeats every 720 degrees', () => {
  for (let angle = 0; angle < 360; angle += 9) {
    const first = getEngineState(angle);
    const second = getEngineState(angle + 360);
    near(first.pistonY, second.pistonY);
    near(first.volume, second.volume);
    assert.notEqual(first.strokeIndex, second.strokeIndex);
    assert.deepEqual(first, getEngineState(angle + 720));
  }
});

test('piston motion uses finite rod geometry, not a sinusoidal approximation', () => {
  const mid = getGeometry(90);
  assert.ok(mid.displacement > ENGINE.stroke / 2);
  near(mid.pistonY, Math.sqrt(ENGINE.rodLength ** 2 - (ENGINE.stroke / 2) ** 2));
});

test('volume matches bore, stroke and the 18:1 compression ratio', () => {
  const tdc = getGeometry(0);
  const bdc = getGeometry(180);
  near(bdc.volume / tdc.volume, ENGINE.compressionRatio);
  near(bdc.volume - tdc.volume, Math.PI * 43 ** 2 * 90 / 1000);
  assert.ok(tdc.sweptVolume > 522 && tdc.sweptVolume < 524);
});

test('air intake and exhaust valves are closed in compression and power strokes', () => {
  for (let angle = 0; angle < 720; angle += 0.5) {
    const s = getEngineState(angle);
    assert.ok(s.intakeLift >= 0 && s.intakeLift <= 7);
    assert.ok(s.exhaustLift >= 0 && s.exhaustLift <= 7);
    assert.ok(!(s.intakeLift > 0 && s.exhaustLift > 0));
    if (s.strokeIndex !== 0) near(s.intakeLift, 0);
    if (s.strokeIndex !== 3) near(s.exhaustLift, 0);
  }
  near(getEngineState(90).intakeLift, 7);
  near(getEngineState(630).exhaustLift, 7);
  for (const angle of [0, 180, 360, 540, 720]) {
    near(getEngineState(angle).intakeLift, 0);
    near(getEngineState(angle).exhaustLift, 0);
  }
});

test('valves never hit the piston in the teaching geometry', () => {
  const clearanceHeight = ENGINE.stroke / (ENGINE.compressionRatio - 1);
  for (const s of sampleCycle(0.25)) {
    assert.ok(Math.max(s.intakeLift, s.exhaustLift) < clearanceHeight + s.displacement);
  }
});

test('diesel injection only happens around compression TDC, never during intake', () => {
  for (let angle = 0; angle < 720; angle++) {
    const s = getEngineState(angle);
    assert.ok(s.injection >= 0 && s.injection <= 1);
    if (angle <= 350 || angle >= 388) near(s.injection, 0);
    else assert.ok(s.injection > 0);
    if (s.strokeIndex !== 2) near(s.combustion, 0);
  }
});

test('compression increases pressure and temperature monotonically', () => {
  let previous = getEngineState(180);
  for (let angle = 181; angle <= 360; angle++) {
    const next = getEngineState(angle);
    assert.ok(next.pressureBar >= previous.pressureBar);
    assert.ok(next.temperatureK >= previous.temperatureK);
    previous = next;
  }
  near(previous.pressureBar, ENGINE.ambientPressure * ENGINE.compressionRatio ** ENGINE.gamma);
});

test('ideal Diesel-cycle heat addition is at constant pressure', () => {
  const start = getEngineState(360);
  for (const angle of [361, 365, 370, 380]) {
    const s = getEngineState(angle);
    assert.ok(s.volume < s.clearanceVolume * ENGINE.cutoffRatio);
    near(s.pressureBar, start.pressureBar);
    near(s.temperatureK / start.temperatureK, s.volume / start.volume);
  }
});

test('closed-cylinder expansion follows pV^gamma and TV^(gamma-1)', () => {
  const first = getEngineState(400);
  const second = getEngineState(500);
  near(first.pressureBar / second.pressureBar, (second.volume / first.volume) ** ENGINE.gamma);
  near(first.temperatureK / second.temperatureK, (second.volume / first.volume) ** (ENGINE.gamma - 1));
});

test('every cycle sample is finite and physically bounded', () => {
  for (const s of sampleCycle(0.25)) {
    for (const key of ['volume', 'pressureBar', 'temperatureK', 'pistonY']) assert.ok(Number.isFinite(s[key]), key);
    assert.ok(s.volume >= s.clearanceVolume - 1e-8);
    assert.ok(s.volume <= s.clearanceVolume + s.sweptVolume + 1e-8);
    assert.ok(s.pressureBar > 0 && s.pressureBar < 100);
    assert.ok(s.temperatureK >= 299 && s.temperatureK < 2500);
  }
});

test('time integration is frame-rate independent within the allowed frame interval', () => {
  for (const fps of [20, 30, 60, 120, 144]) {
    let angle = 0;
    for (let i = 0; i < fps; i++) angle = advanceAngle(angle, 1 / fps, 1200, 1);
    near(angle, 120);
  }
  near(advanceAngle(0, 0.1, 1200, 0.5), 6);
  near(advanceAngle(0, 0.1, 2400, 1), 24);
  near(advanceAngle(0, 0.1, 1200, 2), 24);
});

test('pause, cycle wrapping and suspended-tab recovery do not jump', () => {
  near(advanceAngle(710, 0.1), 2);
  near(advanceAngle(90, 0), 90);
  near(advanceAngle(90, 0.1, 0), 90);
  near(advanceAngle(90, 0.1, 1200, 0), 90);
  near(advanceAngle(90, 60), advanceAngle(90, 0.1));
});

test('invalid model and integration inputs fail clearly', () => {
  for (const patch of [{ bore: 0 }, { stroke: -1 }, { rodLength: 40 }, { compressionRatio: 1 }, { cutoffRatio: 20 }, { gamma: 1 }, { ambientTemperature: NaN }]) {
    assert.throws(() => validateEngine({ ...ENGINE, ...patch }));
  }
  for (const elapsed of [NaN, Infinity, -0.1]) assert.throws(() => advanceAngle(0, elapsed));
  assert.throws(() => advanceAngle(0, 0.01, -1));
  assert.throws(() => advanceAngle(0, 0.01, 1200, -1));
  for (const step of [0, -1, NaN, Infinity, 181]) assert.throws(() => sampleCycle(step));
});

test('cycle sampler covers the full cycle and defaults cannot be mutated', () => {
  const samples = sampleCycle();
  near(samples[0].angle, 0);
  assert.equal(samples.at(-1).strokeIndex, 3);
  assert.ok(samples.at(-1).angle > 719.99);
  assert.ok(Object.isFrozen(ENGINE));
  assert.ok(Object.isFrozen(STROKES));
  assert.ok(STROKES.every(Object.isFrozen));
});
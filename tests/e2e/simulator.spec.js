import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const getState = page => page.evaluate(() => window.__DIESEL_LAB__.getState());
const diagnostics = page => page.evaluate(() => window.__DIESEL_LAB__.getDiagnostics());

async function setRange(page, id, value) {
  await page.locator(`#${id}`).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function nextFrames(page, count = 3) {
  await page.evaluate(frames => new Promise(resolve => {
    const frame = () => { if (--frames <= 0) resolve(); else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }), count);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scene-container')).toHaveAttribute('data-ready', 'true');
});

test('renders actual WebGL meshes with no page errors or remote asset requests', async ({ page }) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.reload();
  await expect(page.locator('#scene-container')).toHaveAttribute('data-ready', 'true');
  const d = await diagnostics(page);
  expect(d.renderer).toBe('WebGL2');
  expect(d.meshCount).toBeGreaterThan(80);
  expect(d.triangles).toBeGreaterThan(20_000);
  expect(d.contextLost).toBe(false);
  expect(d.bigEndError).toBeLessThan(1e-10);
  expect(d.smallEndError).toBeLessThan(1e-10);
  expect(errors).toEqual([]);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4173/') || url.startsWith('data:'))).toBe(true);
  await page.screenshot({ path: 'test-results/desktop-overview.png', fullPage: true });
});

test('stroke selection changes mesh transforms, valves and telemetry together', async ({ page }) => {
  const steps = [
    { index: 0, angle: 90, name: '进气冲程', intake: '开启', exhaust: '关闭' },
    { index: 1, angle: 300, name: '压缩冲程', intake: '关闭', exhaust: '关闭' },
    { index: 2, angle: 395, name: '做功冲程', intake: '关闭', exhaust: '关闭' },
    { index: 3, angle: 630, name: '排气冲程', intake: '关闭', exhaust: '开启' },
  ];
  for (const step of steps) {
    await page.locator(`[data-stroke="${step.index}"]`).click();
    await expect(page.locator('#stroke-name')).toHaveText(step.name);
    await expect(page.locator('#intake-status')).toHaveText(step.intake);
    await expect(page.locator('#exhaust-status')).toHaveText(step.exhaust);
    expect((await getState(page)).angle).toBe(step.angle);
    expect((await getState(page)).playing).toBe(false);
    const d = await diagnostics(page);
    expect(d.rodLength).toBeCloseTo(3, 10);
    expect(d.bigEndError).toBeLessThan(1e-10);
    expect(d.smallEndError).toBeLessThan(1e-10);
  }
});

test('720-degree scrubbing preserves rod length, pin alignment and dead centers', async ({ page }) => {
  for (const angle of [0, 45, 90, 135, 180, 240, 300, 350, 360, 370, 450, 540, 630, 719, 720]) {
    await setRange(page, 'crank-angle', angle);
    const s = await getState(page);
    const d = await diagnostics(page);
    expect(s.angle).toBe(angle % 720);
    expect(d.rodLength).toBeCloseTo(3, 10);
    expect(d.bigEndError).toBeLessThan(1e-10);
    expect(d.smallEndError).toBeLessThan(1e-10);
    if (angle === 0 || angle === 360 || angle === 720) expect(d.pistonPin[1]).toBeCloseTo(3.9, 10);
    if (angle === 180 || angle === 540) expect(d.pistonPin[1]).toBeCloseTo(2.1, 10);
  }
});

test('play, pause, stepping and speed controls work without drift', async ({ page }) => {
  expect((await getState(page)).playing).toBe(false);
  await page.getByRole('button', { name: '播放仿真', exact: true }).click();
  await expect.poll(async () => (await getState(page)).angle).not.toBe(90);
  await page.getByRole('button', { name: '暂停仿真', exact: true }).click();
  const paused = await getState(page);
  const pausedMesh = await diagnostics(page);
  await nextFrames(page, 8);
  expect((await getState(page)).angle).toBe(paused.angle);
  expect((await diagnostics(page)).pistonPin).toEqual(pausedMesh.pistonPin);
  expect((await diagnostics(page)).frames).toBe(pausedMesh.frames);
  await page.getByRole('button', { name: '前进10度', exact: true }).click();
  expect((await getState(page)).angle).toBeCloseTo((paused.angle + 10) % 720, 8);
  await page.locator('[data-speed="0.25"]').click();
  expect((await getState(page)).playbackRate).toBe(0.25);
  await expect(page.locator('#time-scale')).toContainText('1/240');
  await setRange(page, 'rpm', 2400);
  expect((await getState(page)).rpm).toBe(2400);
  await expect(page.locator('#rpm-value')).toHaveText('2,400');
});

test('cutaway, xray and solid genuinely change 3D geometry visibility', async ({ page }) => {
  const before = await getState(page);
  expect((await diagnostics(page)).frontShellVisible).toBe(false);
  await page.locator('[data-mode="xray"]').click();
  const xray = await diagnostics(page);
  expect(xray.frontShellVisible).toBe(true);
  expect(xray.shellOpacity).toBeCloseTo(0.14);
  await page.locator('[data-mode="solid"]').click();
  const solid = await diagnostics(page);
  expect(solid.frontShellVisible).toBe(true);
  expect(solid.shellOpacity).toBe(1);
  await page.locator('[data-mode="cutaway"]').click();
  expect((await diagnostics(page)).frontShellVisible).toBe(false);
  expect((await getState(page)).angle).toBe(before.angle);
});

test('mouse rotation, zoom, camera presets and reset change the actual perspective', async ({ page }) => {
  const initial = await diagnostics(page);
  const canvas = page.locator('#scene-container > canvas');
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.72, rect.y + rect.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await nextFrames(page, 3);
  expect((await diagnostics(page)).camera).not.toEqual(initial.camera);
  await page.getByRole('button', { name: '重置视角', exact: true }).click();
  let d = await diagnostics(page);
  d.camera.forEach((value, index) => expect(value).toBeCloseTo(initial.camera[index], 7));
  await page.getByRole('button', { name: '放大模型', exact: true }).click();
  const zoomed = await diagnostics(page);
  const distance = x => Math.hypot(...x.camera.map((value, index) => value - x.target[index]));
  expect(distance(zoomed)).toBeLessThan(distance(initial));
  await page.locator('[data-camera="front"]').click();
  d = await diagnostics(page);
  expect(d.camera[0]).toBeCloseTo(0);
  await page.locator('[data-camera="side"]').click();
  expect((await diagnostics(page)).camera[0]).toBeGreaterThan(10);
});

test('part highlighting, annotations, particles and auto-orbit are functional', async ({ page }) => {
  await page.locator('[data-part="piston"]').click();
  expect((await diagnostics(page)).selectedPart).toBe('piston');
  await expect(page.locator('#part-description')).toContainText('活塞承受燃气压力');
  await page.locator('[data-part="piston"]').click();
  expect((await diagnostics(page)).selectedPart).toBe(null);
  await page.locator('#show-labels').uncheck();
  await expect(page.locator('#label-layer')).toBeHidden();
  await page.locator('#show-labels').check();
  await expect(page.locator('#label-layer')).toBeVisible();
  await setRange(page, 'crank-angle', 370);
  expect((await diagnostics(page)).fuelVisible).toBe(true);
  await expect(page.locator('#injector-status')).toHaveText('喷油中');
  await page.locator('#show-particles').uncheck();
  expect((await diagnostics(page)).particlesVisible).toBe(false);
  expect((await diagnostics(page)).fuelVisible).toBe(false);
  await page.locator('#show-particles').check();
  expect((await diagnostics(page)).particlesVisible).toBe(true);
  const before = await diagnostics(page);
  await page.locator('#auto-orbit').check();
  await expect.poll(async () => (await diagnostics(page)).camera[0]).not.toBe(before.camera[0]);
});

test('dialogs pause and resume, keyboard controls and reset preserve expected state', async ({ page }) => {
  await page.getByRole('button', { name: '播放仿真', exact: true }).click();
  await page.getByRole('button', { name: '工作原理', exact: true }).click();
  await expect(page.locator('#principle-dialog')).toBeVisible();
  expect((await getState(page)).playing).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#principle-dialog')).toBeHidden();
  // Native dialog.close dispatches its close event in a later task.
  await expect.poll(async () => (await getState(page)).playing).toBe(true);
  await page.locator('#scene-container > canvas').focus();
  await page.keyboard.press('Space');
  expect((await getState(page)).playing).toBe(false);
  const before = (await getState(page)).angle;
  await page.keyboard.press('ArrowRight');
  expect((await getState(page)).angle).toBeCloseTo((before + 10) % 720, 8);
  await page.locator('#rpm').focus();
  await page.keyboard.press('ArrowRight');
  expect((await getState(page)).rpm).toBe(1300);
  expect((await getState(page)).angle).toBeCloseTo((before + 10) % 720, 8);
  await page.locator('#reset-all').click();
  const reset = await getState(page);
  expect(reset.angle).toBe(90);
  expect(reset.rpm).toBe(1200);
  expect(reset.mode).toBe('cutaway');
  expect(reset.playing).toBe(false);
});

test('the p-V marker uses the same state as the model and telemetry', async ({ page }) => {
  await setRange(page, 'crank-angle', 360);
  await expect(page.locator('#pressure-value')).toHaveText('50.16');
  const x = Number(await page.locator('#pv-dot').getAttribute('cx'));
  const y = Number(await page.locator('#pv-dot').getAttribute('cy'));
  expect(x).toBeGreaterThan(43);
  expect(x).toBeLessThan(45);
  expect(y).toBeGreaterThan(41);
  expect(y).toBeLessThan(43);
  expect(await page.locator('#pv-paths path').count()).toBe(4);
});

test('the 3D observer supports keyboard orbit, pan and zoom without changing time', async ({ page }) => {
  const canvas = page.locator('#scene-container > canvas');
  await canvas.focus();
  const initial = await diagnostics(page);
  await page.keyboard.press('a');
  await nextFrames(page, 3);
  expect((await diagnostics(page)).camera).not.toEqual(initial.camera);
  await page.keyboard.press('Shift+w');
  await nextFrames(page, 3);
  expect((await diagnostics(page)).target).not.toEqual(initial.target);
  await page.keyboard.press('r');
  const reset = await diagnostics(page);
  reset.camera.forEach((value, index) => expect(value).toBeCloseTo(initial.camera[index], 7));
  await page.keyboard.press('+');
  await nextFrames(page);
  expect((await diagnostics(page)).camera).not.toEqual(reset.camera);
  expect((await getState(page)).angle).toBe(90);
  await page.keyboard.press('Tab');
  await expect(canvas).not.toBeFocused();
});

test('fullscreen observer opens and exits without resetting the simulation', async ({ page }) => {
  const initial = (await getState(page)).angle;
  await page.getByRole('button', { name: '全屏观察', exact: true }).click();
  await expect(page.locator('#fullscreen')).toHaveAttribute('aria-label', '退出全屏');
  await page.getByRole('button', { name: '退出全屏', exact: true }).click();
  await expect(page.locator('#fullscreen')).toHaveAttribute('aria-label', '全屏观察');
  expect((await getState(page)).angle).toBe(initial);
});

test('narrow screens keep a useful 3D viewport and have no horizontal overflow', async ({ page }) => {
  for (const width of [390, 320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await nextFrames(page);
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      content: document.documentElement.scrollWidth,
      canvasWidth: document.querySelector('#scene-container > canvas').getBoundingClientRect().width,
    }));
    expect(layout.content).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.canvasWidth).toBeGreaterThan(280);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-stroke="2"]').click();
  await expect(page.locator('#stroke-name')).toHaveText('做功冲程');
  await page.screenshot({ path: 'test-results/mobile-overview.png', fullPage: true });
});

test('production HTML runs offline when directly opened via file URL', async ({ page, context }) => {
  const html = await readFile(resolve('dist/index.html'), 'utf8');
  expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  expect(html).not.toMatch(/<link\b[^>]*rel="stylesheet"/i);
  expect(html).toContain('Permission is hereby granted, free of charge');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.setOffline(true);
  await page.goto(pathToFileURL(resolve('dist/index.html')).href);
  await expect(page.locator('#scene-container')).toHaveAttribute('data-ready', 'true');
  await page.locator('[data-stroke="3"]').click();
  await expect(page.locator('#stroke-name')).toHaveText('排气冲程');
  expect((await diagnostics(page)).triangles).toBeGreaterThan(20_000);
  expect(errors).toEqual([]);
});

test('normal-motion preference starts the 3D simulation automatically', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await expect(page.locator('#scene-container')).toHaveAttribute('data-ready', 'true');
  expect((await getState(page)).playing).toBe(true);
  const initial = await getState(page);
  await expect.poll(async () => (await getState(page)).angle).not.toBe(initial.angle);
  await page.getByRole('button', { name: '暂停仿真', exact: true }).click();
  expect((await getState(page)).playing).toBe(false);
});

test('WebGL context loss pauses and restoration recovers without changing angle', async ({ page }) => {
  const before = await getState(page);
  const environmentBefore = (await diagnostics(page)).environmentGeneration;
  await page.evaluate(() => {
    const gl = document.querySelector('#scene-container > canvas').getContext('webgl2');
    window.__contextExtension = gl.getExtension('WEBGL_lose_context');
    window.__contextExtension.loseContext();
  });
  await expect.poll(async () => (await getState(page)).contextLost).toBe(true);
  await expect(page.locator('#scene-message')).toBeVisible();
  await page.evaluate(() => window.__contextExtension.restoreContext());
  await expect.poll(async () => (await getState(page)).contextLost).toBe(false);
  await expect(page.locator('#scene-message')).toBeHidden();
  expect((await getState(page)).playing).toBe(false);
  expect((await getState(page)).angle).toBe(before.angle);
  expect((await diagnostics(page)).environmentGeneration).toBe(environmentBefore + 1);
  await page.locator('[data-stroke="1"]').click();
  expect((await diagnostics(page)).smallEndError).toBeLessThan(1e-10);
});

test('unsupported WebGL shows a clear fallback instead of a fake running model', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return original.call(this, type, ...args);
    };
  });
  await page.reload();
  await expect(page.locator('#scene-message')).toContainText('无法启动三维渲染');
  await expect(page.locator('#play-pause')).toBeDisabled();
  await page.getByRole('button', { name: '工作原理', exact: true }).click();
  await expect(page.locator('#principle-dialog')).toBeVisible();
});
import './style.css';
import { ENGINE, STROKES, advanceAngle, getEngineState, normalizeAngle } from './simulation.js';
import { EngineScene, PART_DETAILS } from './engine-scene.js';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const state = {
  angle: 90, rpm: 1200, playbackRate: 1, playing: !reducedMotion.matches,
  mode: 'cutaway', labels: true, particles: true, autoOrbit: false, selectedPart: null,
};
let scene = null;
let current = getEngineState(state.angle);
let lastTimestamp = null;
let lastUiTimestamp = -Infinity;
let lastStroke = -1;
let ready = false;
let contextLost = false;
let activeDialog = null;
let resumeAfterDialog = false;
const modeNames = { cutaway: '剖视模式', xray: '透视模式', solid: '实体模式' };
const modeDescriptions = {
  cutaway: '剖开前半侧缸体，观察内部运动。',
  xray: '保留透明外壳，透视内部结构。',
  solid: '完整外观；旋转模型探索各个侧面。',
};
const partDefaultText = $('part-description').textContent;
const refs = Object.fromEntries([
  'angle-value', 'crank-angle', 'stroke-name', 'stroke-english', 'stroke-counter',
  'stroke-description', 'stroke-progress', 'phase-progress', 'direction-label', 'energy-label',
  'scene-phase', 'pressure-value', 'temperature-value', 'displacement-value', 'volume-value',
  'intake-status', 'exhaust-status', 'injector-status', 'pv-dot', 'pv-dot-halo',
].map(id => [id, $(id)]));

function announce(message) {
  $('announcement').textContent = message;
}

function markPressed(selector, attribute, value) {
  $$(selector).forEach(button => button.setAttribute('aria-pressed', String(button.dataset[attribute] === String(value))));
}

function updateTransport() {
  const playing = state.playing && ready && !contextLost;
  $('play-pause').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play-pause').querySelector('span').textContent = playing ? '暂停' : '播放';
  $('play-pause').setAttribute('aria-label', playing ? '暂停仿真' : '播放仿真');
  $('playback-state').innerHTML = `<span class="status-dot"></span>${playing ? '运行中' : '已暂停'}`;
  $('playback-state').classList.toggle('is-paused', !playing);
}

function setPlaying(playing, notify = true) {
  if (!ready || contextLost) return;
  state.playing = playing;
  lastTimestamp = null;
  updateTransport();
  if (notify) announce(playing ? '仿真已播放' : '仿真已暂停');
}

function drawNow() {
  current = getEngineState(state.angle);
  if (scene && !contextLost) scene.render(current, 0);
  updateTelemetry();
}

function seek(angle, notify = false) {
  if (!ready || contextLost) return;
  setPlaying(false, false);
  state.angle = normalizeAngle(angle);
  drawNow();
  if (notify) announce(`${current.stroke.name}冲程，曲轴转角 ${Math.floor(state.angle)} 度`);
}

function selectPart(part) {
  if (!scene) return;
  state.selectedPart = part === state.selectedPart ? null : part;
  if (!PART_DETAILS[state.selectedPart]) state.selectedPart = null;
  scene.selectPart(state.selectedPart);
  markPressed('[data-part]', 'part', state.selectedPart);
  $('part-description').textContent = PART_DETAILS[state.selectedPart] || partDefaultText;
}

function setMode(mode) {
  if (!scene || !modeNames[mode]) return;
  state.mode = mode;
  scene.setMode(mode);
  markPressed('[data-mode]', 'mode', mode);
  $('view-mode-label').textContent = modeNames[mode];
  $('mode-description').textContent = modeDescriptions[mode];
  announce(`已切换到${modeNames[mode]}`);
}

function setCamera(preset) {
  if (!scene) return;
  state.autoOrbit = false;
  $('auto-orbit').checked = false;
  scene.setCamera(preset);
  markPressed('[data-camera]', 'camera', preset);
}

function statusBadge(element, value, active, injecting = false) {
  element.textContent = value;
  element.classList.toggle('is-active', active && !injecting);
  element.classList.toggle('is-injecting', active && injecting);
}

function chartPoint(engineState) {
  return [32 + engineState.volume / 600 * 234, 144 - (engineState.pressureBar / 10) / 6 * 122];
}

function updateTelemetry() {
  const { stroke, strokeIndex } = current;
  if (lastStroke !== strokeIndex) {
    document.documentElement.style.setProperty('--phase', stroke.color);
    document.body.dataset.stroke = stroke.id;
    refs['stroke-name'].textContent = `${stroke.name}冲程`;
    refs['scene-phase'].textContent = `${stroke.name}冲程`;
    refs['stroke-english'].textContent = `${stroke.english} STROKE`;
    refs['stroke-counter'].innerHTML = `0${strokeIndex + 1}<span>/ 04</span>`;
    refs['stroke-description'].textContent = stroke.description;
    refs['energy-label'].textContent = stroke.energy;
    markPressed('[data-stroke]', 'stroke', strokeIndex);
    lastStroke = strokeIndex;
  }
  refs['angle-value'].innerHTML = `${Math.floor(state.angle)}<span>°</span>`;
  refs['crank-angle'].value = String(state.angle);
  refs['crank-angle'].setAttribute('aria-valuetext', `${Math.floor(state.angle)} 度，${stroke.name}冲程`);
  refs['stroke-progress'].style.width = `${current.progress * 100}%`;
  refs['phase-progress'].textContent = `${Math.floor(current.progress * 100)}%`;
  refs['direction-label'].textContent = current.direction === '止点' ? '活塞位于止点' : `活塞${current.direction}`;
  refs['pressure-value'].textContent = current.pressureBar.toFixed(2);
  refs['temperature-value'].textContent = Math.round(current.temperatureK - 273.15).toLocaleString('zh-CN');
  refs['displacement-value'].textContent = current.displacement.toFixed(1);
  refs['volume-value'].textContent = current.volume.toFixed(1);
  statusBadge(refs['intake-status'], current.intakeLift > 0.01 ? '开启' : '关闭', current.intakeLift > 0.01);
  statusBadge(refs['exhaust-status'], current.exhaustLift > 0.01 ? '开启' : '关闭', current.exhaustLift > 0.01);
  statusBadge(refs['injector-status'], current.injection > 0 ? '喷油中' : '待命', current.injection > 0, true);
  const [x, y] = chartPoint(current);
  for (const dot of [refs['pv-dot'], refs['pv-dot-halo']]) {
    dot.setAttribute('cx', x.toFixed(3));
    dot.setAttribute('cy', y.toFixed(3));
  }
}

function svgElement(tag, attributes, content) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}

function createChart() {
  const grid = $('pv-grid');
  const textStyle = { fill: '#7d97a2', 'font-size': '8', 'font-family': 'Consolas, monospace' };
  for (const pressure of [0, 2, 4, 6]) {
    const y = 144 - pressure / 6 * 122;
    grid.append(svgElement('line', { x1: 32, y1: y, x2: 266, y2: y, stroke: '#293c45', 'stroke-dasharray': '3 4', 'stroke-width': 0.7 }));
    grid.append(svgElement('text', { ...textStyle, x: 23, y: y + 3, 'text-anchor': 'end' }, String(pressure)));
  }
  for (const volume of [0, 200, 400, 600]) {
    const x = 32 + volume / 600 * 234;
    grid.append(svgElement('line', { x1: x, y1: 22, x2: x, y2: 144, stroke: '#253841', 'stroke-dasharray': '3 4', 'stroke-width': 0.7 }));
    grid.append(svgElement('text', { ...textStyle, x, y: 158, 'text-anchor': 'middle' }, String(volume)));
  }
  grid.append(svgElement('text', { ...textStyle, x: 8, y: 12, 'font-size': 8 }, 'p / MPa'));
  grid.append(svgElement('text', { ...textStyle, x: 265, y: 175, 'text-anchor': 'end' }, 'V / cm³'));
  const paths = $('pv-paths');
  for (const stroke of STROKES) {
    const points = [];
    for (let angle = stroke.start; angle < stroke.end; angle += 1.5) {
      points.push(chartPoint(getEngineState(angle)));
    }
    points.push(chartPoint(getEngineState(stroke.end - 1e-7)));
    points.push(chartPoint(getEngineState(stroke.end)));
    const d = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
    paths.append(svgElement('path', { d, fill: 'none', stroke: stroke.color, 'stroke-width': stroke.id === 'power' ? 1.9 : 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.86 }));
  }
}

function updateSpeed() {
  markPressed('[data-speed]', 'speed', state.playbackRate);
  $('time-scale').textContent = `教学慢放 · 1/${60 / state.playbackRate} 实时速度`;
}

function updateRpm() {
  $('rpm-value').textContent = state.rpm.toLocaleString('zh-CN');
  $('rpm').value = String(state.rpm);
  $('rpm').style.setProperty('--range-progress', `${(state.rpm - 600) / 1800 * 100}%`);
}

function resetAll() {
  if (!ready) return;
  state.angle = 90;
  state.rpm = 1200;
  state.playbackRate = 1;
  state.labels = true;
  state.particles = true;
  state.selectedPart = null;
  $('show-labels').checked = true;
  $('show-particles').checked = true;
  scene.setLabels(true);
  scene.setParticles(true);
  scene.selectPart(null);
  markPressed('[data-part]', 'part', null);
  $('part-description').textContent = partDefaultText;
  setMode('cutaway');
  setCamera('perspective');
  updateRpm();
  updateSpeed();
  setPlaying(!reducedMotion.matches, false);
  drawNow();
  announce('实验已重置：进气冲程，1200 rpm，剖视模式');
}

function updateFullscreenLabel() {
  const active = document.fullscreenElement === $('viewport-panel') || $('viewport-panel').classList.contains('is-expanded');
  $('fullscreen').setAttribute('aria-label', active ? '退出全屏' : '全屏观察');
  $('fullscreen').title = active ? '退出全屏 (Esc)' : '全屏观察';
  document.body.style.overflow = active ? 'hidden' : '';
}

async function toggleFullscreen() {
  const panel = $('viewport-panel');
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else if (panel.classList.contains('is-expanded')) {
    panel.classList.remove('is-expanded');
  } else if (panel.requestFullscreen && document.fullscreenEnabled) {
    try {
      await panel.requestFullscreen();
    } catch {
      // Embedded browser policies may reject the native fullscreen API.
      panel.classList.add('is-expanded');
    }
  } else {
    panel.classList.add('is-expanded');
  }
  updateFullscreenLabel();
}

function openDialog(id) {
  if (activeDialog) return;
  const dialog = $(id);
  resumeAfterDialog = state.playing;
  setPlaying(false, false);
  activeDialog = dialog;
  dialog.showModal();
}

function bindUI() {
  $('play-pause').addEventListener('click', () => setPlaying(!state.playing));
  $('step-forward').addEventListener('click', () => seek(state.angle + 10, true));
  $('reset-cycle').addEventListener('click', () => seek(0, true));
  $('crank-angle').addEventListener('input', event => seek(Number(event.target.value)));
  $('crank-angle').addEventListener('change', () => announce(`已定格在 ${Math.floor(state.angle)} 度，${current.stroke.name}冲程`));
  $('rpm').addEventListener('input', event => {
    state.rpm = Number(event.target.value);
    updateRpm();
  });
  $$('[data-stroke]').forEach(button => button.addEventListener('click', () => seek(STROKES[Number(button.dataset.stroke)].preview, true)));
  $$('[data-speed]').forEach(button => button.addEventListener('click', () => {
    state.playbackRate = Number(button.dataset.speed);
    updateSpeed();
  }));
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  $$('[data-camera]').forEach(button => button.addEventListener('click', () => setCamera(button.dataset.camera)));
  $$('[data-part]').forEach(button => button.addEventListener('click', () => selectPart(button.dataset.part)));
  $('show-labels').addEventListener('change', event => {
    state.labels = event.target.checked;
    scene?.setLabels(state.labels);
  });
  $('show-particles').addEventListener('change', event => {
    state.particles = event.target.checked;
    scene?.setParticles(state.particles);
    if (ready) drawNow();
  });
  $('auto-orbit').addEventListener('change', event => {
    state.autoOrbit = event.target.checked;
    if (scene) {
      scene.controls.autoRotate = state.autoOrbit;
      scene.currentCamera = null;
      markPressed('[data-camera]', 'camera', null);
    }
  });
  $('zoom-in').addEventListener('click', () => scene?.zoom(0.86));
  $('zoom-out').addEventListener('click', () => scene?.zoom(1.16));
  $('reset-camera').addEventListener('click', () => setCamera('perspective'));
  $('reset-all').addEventListener('click', resetAll);
  $('fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenLabel);

  $$('[data-dialog]').forEach(button => button.addEventListener('click', () => openDialog(button.dataset.dialog)));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      activeDialog = null;
      if (resumeAfterDialog) setPlaying(true, false);
      resumeAfterDialog = false;
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('viewport-panel').classList.contains('is-expanded')) {
      $('viewport-panel').classList.remove('is-expanded');
      updateFullscreenLabel();
    }
    if (!ready || activeDialog || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (event.target.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
    if (event.target === scene?.renderer.domElement && scene.keyboardCamera(event.key.toLowerCase(), event.shiftKey)) {
      event.preventDefault();
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      setPlaying(!state.playing);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      seek(state.angle + (event.key === 'ArrowRight' ? 10 : -10), true);
    } else if (event.key.toLowerCase() === 'r') {
      setCamera('perspective');
    }
  });
  document.addEventListener('visibilitychange', () => { lastTimestamp = null; });
  reducedMotion.addEventListener('change', event => {
    if (!event.matches) return;
    setPlaying(false);
    state.autoOrbit = false;
    $('auto-orbit').checked = false;
    if (scene) scene.controls.autoRotate = false;
  });
}

function showError(title, detail) {
  state.playing = false;
  ready = false;
  updateTransport();
  $('scene-container').dataset.ready = 'false';
  $('scene-container').setAttribute('aria-busy', 'false');
  $('renderer-status').textContent = '3D 渲染不可用';
  const message = $('scene-message');
  message.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = title;
  const description = document.createElement('span');
  description.textContent = detail;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button button-primary';
  retry.textContent = '重新加载';
  retry.addEventListener('click', () => window.location.reload());
  message.append(heading, description, retry);
  message.hidden = false;
  // Keep the educational dialogs available, but never pretend a failed renderer is running.
  $$('.options-column button, .options-column input, .viewport-tools button, .camera-presets button, .playback-panel button, .playback-panel input, .stroke-card, #reset-all')
    .forEach(element => { element.disabled = true; });
}

function animate(timestamp) {
  if (document.hidden || contextLost || !ready) {
    lastTimestamp = null;
    return;
  }
  const elapsed = lastTimestamp === null ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1000);
  lastTimestamp = timestamp;
  if (state.playing) {
    state.angle = advanceAngle(state.angle, elapsed, state.rpm, state.playbackRate);
    current = getEngineState(state.angle);
  }
  scene.render(current, elapsed);
  if ((state.playing && timestamp - lastUiTimestamp >= 70) || lastStroke !== current.strokeIndex) {
    updateTelemetry();
    lastUiTimestamp = timestamp;
  }
}

function start() {
  bindUI();
  createChart();
  updateRpm();
  updateSpeed();
  updateTelemetry();
  try {
    scene = new EngineScene($('scene-container'), $('label-layer'), {
      onPartSelect: selectPart,
      onCameraChange: () => {
        scene.currentCamera = null;
        markPressed('[data-camera]', 'camera', null);
      },
    });
    scene.render(current, 0);
    const canvas = scene.renderer.domElement;
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      contextLost = true;
      setPlaying(false, false);
      state.playing = false;
      updateTransport();
      $('renderer-status').textContent = '等待图形上下文恢复';
      $('scene-message').hidden = false;
      $('scene-message').querySelector('strong').textContent = '图形上下文暂时中断';
      $('scene-message').querySelector('span:not(.loader)').textContent = '正在等待浏览器恢复；恢复后保持暂停，可继续播放。';
    });
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false;
      lastTimestamp = null;
      // GPU-only render targets lose their contents when the context is lost;
      // recreate the studio reflections instead of restoring an empty texture.
      scene.refreshEnvironment();
      scene.lastAngle = null;
      $('scene-message').hidden = true;
      $('renderer-status').textContent = 'WebGL 实时渲染';
      drawNow();
    });
    ready = true;
    $('scene-container').dataset.ready = 'true';
    $('scene-container').setAttribute('aria-busy', 'false');
    $('scene-message').hidden = true;
    $('renderer-status').textContent = 'WebGL 实时渲染';
    updateTransport();
    scene.renderer.setAnimationLoop(animate);

    // Read-only diagnostics enable tests to verify actual mesh transforms,
    // rather than treating a canvas or a changing UI counter as proof of 3D.
    window.__DIESEL_LAB__ = Object.freeze({
      getState: () => ({ ...state, stroke: current.stroke.id, pressureBar: current.pressureBar, temperatureK: current.temperatureK, ready, contextLost }),
      getDiagnostics: () => scene.diagnostics(),
      parameters: ENGINE,
    });
  } catch (error) {
    console.error('3D engine initialization failed:', error);
    scene?.dispose();
    showError('无法启动三维渲染', '请使用支持 WebGL 2 的新版 Edge、Chrome 或 Firefox，并检查浏览器的硬件加速设置。本页面不会用二维动画代替三维模型。');
  }
}

start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    scene?.dispose();
  });
}
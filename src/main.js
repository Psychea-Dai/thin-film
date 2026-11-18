// =============================================================================
// main.js —— 程序入口
// 负责：创建 Three.js 渲染器、铺一块全屏平面、把 CONFIG 传给着色器、每帧渲染。
// =============================================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createPointer } from './interaction.js';
import { createAudioEngine } from './audio.js';
import { createBeat } from './beat.js';
import { createUI } from './ui.js';
// 末尾的 ?raw 是 Vite 的写法：把文件内容当成一段字符串导入
import vertexShader from './shaders/film.vert.glsl?raw';
import fragmentShader from './shaders/film.frag.glsl?raw';

// ---- 1. 渲染器（renderer）：把画面画到 <canvas> 上 ----
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,          // 全屏着色器不需要几何抗锯齿，关掉省性能
  powerPreference: 'high-performance',
});

// ---- 2. 场景、相机、全屏平面 ----
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // 实际不参与计算
const geometry = new THREE.PlaneGeometry(2, 2);

// ---- 3. uniform：从 CONFIG 自动生成 ----
// 规则：CONFIG.film.baseThickness -> 着色器里的 uBaseThickness
// 数字 -> float，长度 2 的数组 -> vec2，长度 3 的数组 -> vec3
const PASSED_GROUPS = ['optics', 'film', 'layout', 'grade'];
const uniforms = {
  uResolution: { value: new THREE.Vector2() },
  uTime: { value: 0 },
  uSeed: { value: 0 },
  uPointer: { value: new THREE.Vector2() },
  uPointerOffset: { value: new THREE.Vector2() },
  uPointerRadius: { value: 0 },
  uPointerStrength: { value: 0 },
  uPointerThicken: { value: 0 },
  uHeartLead: { value: new THREE.Vector2() },
  uHeartTrail: { value: new THREE.Vector2() },
  uHeartBaseSize: { value: 0 },
  uHeartProgress: { value: 0 },
};

function uniformName(key) {
  return 'u' + key[0].toUpperCase() + key.slice(1);
}

function toUniformValue(v) {
  if (Array.isArray(v) && v.length === 2) return new THREE.Vector2(...v);
  if (Array.isArray(v) && v.length === 3) return new THREE.Vector3(...v);
  return v;
}

for (const group of PASSED_GROUPS) {
  for (const [key, v] of Object.entries(CONFIG[group])) {
    uniforms[uniformName(key)] = { value: toUniformValue(v) };
  }
}

// 每帧把 CONFIG 的最新值抄到 uniform 里，这样在控制台改 CONFIG 能实时看到效果
function syncConfigToUniforms() {
  for (const group of PASSED_GROUPS) {
    for (const [key, v] of Object.entries(CONFIG[group])) {
      const u = uniforms[uniformName(key)];
      if (Array.isArray(v)) u.value.fromArray(v);
      else u.value = v;
    }
  }
}

const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
scene.add(new THREE.Mesh(geometry, material));

// ---- 4. 尺寸：窗口变化时重设画布分辨率 ----
function resize() {
  const ratio = Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio) * CONFIG.render.renderScale;
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight, false); // false：不改 CSS 尺寸
  renderer.getDrawingBufferSize(uniforms.uResolution.value);
}
window.addEventListener('resize', resize);
resize();

// ---- 5. 状态：会随时间变化的量 ----
const state = {
  flowTime: 0,     // 流动时间：不是真实时间，而是“流过了多少”，速度变化时不会跳
  clock: 0,        // 真实经过的秒数（只在页面可见时累加）
};

// ---- 6. 声音与节拍 ----
const audio = createAudioEngine();
const beat = createBeat();
const ui = createUI({
  audio,
  beat,
  onQualityChange(scale) {
    CONFIG.render.renderScale = scale;
    resize();
  },
});

// 调制（modulation）：在 CONFIG 的基础值上叠加随时间变化的量。
// 每帧先把 CONFIG 原值抄进 uniform，再在这里“加料”，CONFIG 本身不会被改动。
function applyModulation() {
  const f = CONFIG.film;
  const m = CONFIG.motion;
  const k = CONFIG.mapping;
  const [low, mid, high] = audio.state.bands;   // 三个频段，0~1
  const pulse = beat.state.pulse;               // 鼓点脉冲，0~1
  const breath = beat.breath() * beat.state.lfoMix; // LFO 呼吸，-1~1（有声音时减弱）

  // 低频：心形大小 + 整体厚度起伏
  uniforms.uBaseThickness.value = f.baseThickness + breath * m.breathThickness + low * k.lowThickness;
  uniforms.uHeartGrow.value = f.heartGrow + breath * m.breathHeart + low * k.lowHeart + pulse * k.pulseHeart;
  // 光晕和内核：低频起伏 + 鼓点脉冲
  uniforms.uBlobHaloAmp.value = f.blobHaloAmp + breath * m.breathHalo + low * k.lowThickness * 0.8 + pulse * k.pulseHalo;
  uniforms.uBlobCoreAmp.value = f.blobCoreAmp + pulse * k.pulseCore;
  // 中频：扭曲强度（流动速度在 frame() 里处理）
  uniforms.uWarpAmount.value = f.warpAmount + mid * k.midWarp;
  // 高频：细纹密度
  uniforms.uStreakFreq.value = f.streakFreq * (1 + high * k.highStreak);
}

// ---- 7. 心形放大与倒放 ----
// 放大进度 progress：0 = 原样，1 = 接近全屏。按“停 -> 放大 -> 停 -> 缩回”循环。
// 心形的位置、大小、拖拽、变形全部只由 progress 决定，所以缩回时是放大过程的精确倒放。
const heart = { progress: 0 };
const ease = (x) => x * x * (3 - 2 * x);  // smoothstep：两头慢、中间快
const lerp = (a, b, k) => a + (b - a) * k;

function heartProgress(clock) {
  const m = CONFIG.motion;
  const phase = (clock / m.heartCycle) % 1;
  const move = (1 - m.heartRestShare - m.heartFullShare) / 2;   // 放大和缩回各占的时间
  if (phase < m.heartRestShare) return 0;
  if (phase < m.heartRestShare + move) return ease((phase - m.heartRestShare) / move);
  if (phase < m.heartRestShare + move + m.heartFullShare) return 1;
  return 1 - ease((phase - m.heartRestShare - move - m.heartFullShare) / move);
}

function applyHeart() {
  const m = CONFIG.motion;
  const f = CONFIG.film;
  const g = heartProgress(state.clock);
  heart.progress = g;
  // 尖端提前到达：g 达到 1/(1+lead) 时尖端已经走完，心瓣继续追 -> 放大过程中心形被拉长
  const gLead = ease(Math.min(g * (1 + m.heartTipLead), 1));
  const size = lerp(f.heartSize, m.heartMaxSize, g);
  uniforms.uHeartLead.value.set(lerp(f.heartTip[0], m.heartMaxTip[0], gLead), lerp(f.heartTip[1], m.heartMaxTip[1], gLead));
  uniforms.uHeartTrail.value.set(lerp(f.heartTip[0], m.heartMaxTip[0], g), lerp(f.heartTip[1], m.heartMaxTip[1], g));
  uniforms.uHeartSize.value = size;
  uniforms.uHeartBaseSize.value = f.heartSize;
  uniforms.uHeartProgress.value = g;
}

// ---- 8. 交互 ----
const pointer = createPointer(canvas);

function applyPointer(dt) {
  pointer.update(dt);
  const p = pointer.state;
  uniforms.uPointer.value.set(p.pos.x, p.pos.y);
  uniforms.uPointerOffset.value.set(p.offset.x, p.offset.y);
  uniforms.uPointerRadius.value = CONFIG.pointer.radius;
  uniforms.uPointerStrength.value = p.strength;
  uniforms.uPointerThicken.value = CONFIG.pointer.thicken;
}

// ---- 9. 动画循环 ----
let lastTime = performance.now();

function frame(now) {
  // dt：距离上一帧过了多少秒。限制最大值，防止卡顿或切回页面时画面猛跳
  const dt = Math.min((now - lastTime) / 1000, CONFIG.motion.maxDelta);
  lastTime = now;

  state.clock += dt;

  // 声音分析 -> 节拍检测
  audio.update(dt);
  beat.update(dt, audio.state.flux, audio.state.mode !== 'off', audio.state.silentFor);

  // 关键：流动时间是“累加”出来的。中频让速度变快时，画面只会流得更快，不会瞬移
  const mid = audio.state.bands[1];
  state.flowTime += dt * (CONFIG.motion.flowSpeed + mid * CONFIG.mapping.midFlow);

  syncConfigToUniforms();
  applyModulation();
  applyPointer(dt);
  applyHeart();
  uniforms.uTime.value = state.flowTime;
  uniforms.uSeed.value = Math.random();
  renderer.render(scene, camera);
  ui.update(dt);
}

function start() {
  lastTime = performance.now();
  renderer.setAnimationLoop(frame);
}
function stop() {
  renderer.setAnimationLoop(null);
}

// 页面被切到后台（换标签页、最小化）时暂停渲染，省电省 GPU
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else start();
  audio.setPaused(document.hidden);
});
start();

// 开发模式下把 CONFIG 挂到 window 上，方便在控制台调参
if (import.meta.env.DEV) {
  window.CONFIG = CONFIG;
  window.__film = { renderer, scene, camera, uniforms, state, pointer, audio, beat, heart, applyHeart }; // 调试用：测性能
}

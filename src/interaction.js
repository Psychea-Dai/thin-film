// =============================================================================
// interaction.js —— 鼠标 / 触屏交互（C 阶段）
//
// 思路：手指（或鼠标）划过时，给附近的液膜一个“推力”。
// 推力不会直接变成位移，而是先变成速度，再由一根看不见的弹簧把位移拉回 0。
// 于是液膜会被带着走一小段，然后缓慢回弹，像有黏性的液体。
//
// 第一版只做局部变形，不做流体模拟。以后可以加 ping-pong 缓冲（两张贴图交替读写）
// 把每一帧的变形“记住”，形成拖尾。
// =============================================================================
import { CONFIG } from './config.js';

// 把屏幕上的像素位置换算成着色器里的坐标（必须与 film.frag.glsl 的 main() 保持一致）
export function screenToFilm(clientX, clientY) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let x = (clientX - w / 2) / h;
  let y = (h / 2 - clientY) / h;   // 屏幕 y 向下，着色器 y 向上，所以要翻转
  const aspect = w / h;
  const frame = CONFIG.layout.frameAspect;
  if (aspect < frame) {   // 比 16:9 窄：整体缩小（与着色器一致）
    x *= frame / aspect;
    y *= frame / aspect;
  }
  return { x, y };
}

export function createPointer(element) {
  const s = {
    target: { x: 0, y: 0 },   // 指针真实位置
    pos: { x: 0, y: 0 },      // 平滑后的位置（变形的中心）
    offset: { x: 0, y: 0 },   // 当前变形量（被弹簧拉着）
    vel: { x: 0, y: 0 },      // 变形量的变化速度
    impulse: { x: 0, y: 0 },  // 这一帧累积的移动量
    strength: 0,              // 交互强度 0~1，停止移动后慢慢消失
    lastMove: -1e9,           // 上次移动的时间（毫秒）
    hasPointer: false,
  };

  function onMove(e) {
    const p = screenToFilm(e.clientX, e.clientY);
    if (s.hasPointer) {
      // 记录这一帧移动了多少，作为推力
      s.impulse.x += p.x - s.target.x;
      s.impulse.y += p.y - s.target.y;
    } else {
      // 第一次出现（或手指刚按下）：直接跳到该位置，不产生推力，避免画面猛跳
      s.pos.x = p.x;
      s.pos.y = p.y;
      s.hasPointer = true;
    }
    s.target.x = p.x;
    s.target.y = p.y;
    s.lastMove = performance.now();
  }

  // Pointer Events 同时支持鼠标、触屏和手写笔
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') s.hasPointer = false; // 手指重新按下：重新定位
    onMove(e);
  });
  element.addEventListener('pointerleave', () => { s.hasPointer = false; });

  // 每帧调用一次。dt：距上一帧的秒数
  function update(dt) {
    const c = CONFIG.pointer;

    // 1) 指数平滑（exponential smoothing）：位置每帧向目标靠近一部分。
    //    1 - exp(-dt / τ) 能保证不同帧率下的跟随速度一样。
    const follow = 1 - Math.exp(-dt / c.followTime);
    s.pos.x += (s.target.x - s.pos.x) * follow;
    s.pos.y += (s.target.y - s.pos.y) * follow;

    // 2) 推力 -> 速度
    s.vel.x += s.impulse.x * c.impulseGain;
    s.vel.y += s.impulse.y * c.impulseGain;
    s.impulse.x = 0;
    s.impulse.y = 0;

    // 3) 弹簧（spring）：拉回力与位移成正比（胡克定律），阻尼与速度成正比
    const ax = -c.stiffness * s.offset.x - c.damping * s.vel.x;
    const ay = -c.stiffness * s.offset.y - c.damping * s.vel.y;
    s.vel.x += ax * dt;
    s.vel.y += ay * dt;
    s.offset.x += s.vel.x * dt;
    s.offset.y += s.vel.y * dt;

    // 4) 限制最大变形，避免甩得太猛把画面扯坏
    const len = Math.hypot(s.offset.x, s.offset.y);
    if (len > c.maxOffset) {
      s.offset.x *= c.maxOffset / len;
      s.offset.y *= c.maxOffset / len;
    }

    // 5) 交互强度：移动时淡入，停下后慢慢淡出
    const idle = (performance.now() - s.lastMove) / 1000;
    const targetStrength = s.hasPointer && idle < c.idleFade ? 1 : 0;
    const k = 1 - Math.exp(-dt / (targetStrength > s.strength ? 0.15 : c.idleFade));
    s.strength += (targetStrength - s.strength) * k;
  }

  return { state: s, update };
}

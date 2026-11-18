// =============================================================================
// ui.js —— 控制面板（D 阶段）
// 只负责“按钮 <-> 功能”的连接，以及每帧刷新电平表。所有逻辑在 audio.js / beat.js 里。
// =============================================================================
import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);

export function createUI({ audio, beat, onQualityChange }) {
  const panel = $('panel');
  const status = $('status');
  const micBtn = $('mic');
  const testBtn = $('test');
  const tempoSource = $('tempoSource');
  const bpmInput = $('bpm');

  function setStatus(text) { status.textContent = text; }

  function refreshButtons() {
    micBtn.classList.toggle('on', audio.state.mode === 'mic');
    testBtn.classList.toggle('on', audio.state.mode === 'test');
  }

  // ---- 麦克风 ----
  micBtn.addEventListener('click', async () => {
    if (audio.state.mode === 'mic') { audio.stop(); refreshButtons(); setStatus(''); return; }
    try {
      setStatus('Requesting microphone access…');
      await audio.startMic();
      // 检查浏览器是否真的关掉了通话处理（有的浏览器会忽略请求）
      const st = audio.state.trackSettings || {};
      const stillOn = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => st[k] === true);
      setStatus(stillOn.length ? `Note: the browser still has ${stillOn.join(', ')} enabled` : 'Microphone on (voice processing off)');
    } catch (err) {
      setStatus(err.name === 'NotAllowedError' ? 'Microphone access denied' : `Could not start microphone: ${err.message}`);
    }
    refreshButtons();
  });

  // ---- 测试信号 ----
  testBtn.addEventListener('click', async () => {
    if (audio.state.mode === 'test') { audio.stop(); setStatus(''); }
    else { await audio.startTest(); setStatus('Test signal: 122 BPM synthetic beat'); }
    refreshButtons();
  });

  // ---- 节拍 ----
  tempoSource.addEventListener('change', () => { beat.state.tempoSource = tempoSource.value; });
  $('tap').addEventListener('click', () => { beat.tap(); tempoSource.value = 'tap'; });
  bpmInput.addEventListener('change', () => {
    const v = parseFloat(bpmInput.value);
    if (v >= 40 && v <= 240) {
      beat.state.manualBpm = v;
      beat.state.tempoSource = 'manual';
      tempoSource.value = 'manual';
    }
  });

  // ---- 画质 ----
  $('quality').value = String(CONFIG.render.renderScale);
  $('quality').addEventListener('change', (e) => onQualityChange(parseFloat(e.target.value)));

  // ---- 显示 / 隐藏 ----
  const showBtn = $('show');
  function setHidden(hidden) {
    panel.classList.toggle('hidden', hidden);
    showBtn.classList.toggle('visible', hidden);
  }
  $('hide').addEventListener('click', () => setHidden(true));
  showBtn.addEventListener('click', () => setHidden(false));

  // 键盘：H 显示/隐藏，T 点按测速（在输入框里打字时不触发）
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'h' || e.key === 'H') setHidden(!panel.classList.contains('hidden'));
    if (e.key === 't' || e.key === 'T') { beat.tap(); tempoSource.value = 'tap'; }
  });

  // 鼠标静止 3 秒后面板淡出，动一下就回来
  let idleTimer = 0;
  function wake() {
    panel.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => panel.classList.add('idle'), 3000);
  }
  window.addEventListener('pointermove', wake);
  wake();

  // ---- 每帧刷新 ----
  const meters = [$('mLow'), $('mMid'), $('mHigh')];
  const pulseDot = $('pulse');
  const tempoReadout = $('tempoReadout');
  const fpsEl = $('fps');
  let fps = 60;
  let readoutTimer = 0;

  function update(dt) {
    const b = audio.state.bands;
    for (let i = 0; i < 3; i++) meters[i].style.transform = `scaleX(${b[i].toFixed(3)})`;
    pulseDot.style.opacity = (0.1 + 0.9 * beat.state.pulse).toFixed(3);

    if (dt > 0) fps += (1 / dt - fps) * 0.05;   // 平滑后的帧率
    readoutTimer -= dt;
    if (readoutTimer <= 0) {                    // 文字每 0.25 秒刷新一次就够了
      readoutTimer = 0.25;
      fpsEl.textContent = `${Math.round(fps)} fps`;
      const s = beat.state;
      const auto = s.autoBpm ? `Auto ≈ ${s.autoBpm.toFixed(1)} (confidence ${s.autoConfidence.toFixed(1)})` : 'Auto: waiting for onsets…';
      const current = beat.bpm() ? `Now ${beat.bpm().toFixed(1)} BPM` : 'Grid off';
      tempoReadout.textContent = `${current} · ${auto}`;
    }
  }

  return { update };
}

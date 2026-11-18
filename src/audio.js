// =============================================================================
// audio.js —— 麦克风输入与频谱分析（D 阶段）
//
// 数据流：
//   麦克风 / 测试信号 ──> AnalyserNode（做 FFT，傅里叶变换）──> 每帧读出频谱
//   频谱 ──> 低 / 中 / 高三个频段的能量 ──> 自适应增益 ──> attack/release 平滑 ──> 0~1 的三个数
//   频谱 ──> 频谱通量（spectral flux）──> 交给 beat.js 做起拍检测
// =============================================================================
import { CONFIG } from './config.js';

export function createAudioEngine() {
  const s = {
    ctx: null,            // AudioContext：浏览器的音频处理环境
    analyser: null,
    source: null,         // 当前接入的音源节点
    stream: null,         // 麦克风的媒体流
    testTimer: null,      // 测试信号的调度定时器
    cleanup: null,        // 停止测试信号时的收尾函数
    mode: 'off',          // 'off' | 'mic' | 'test'
    trackSettings: null,  // 浏览器实际采用的麦克风设置（用于检查降噪是否真的关了）

    db: null,             // 本帧频谱（分贝）
    prevNorm: null,       // 上一帧归一化频谱（算通量用）
    flux: 0,              // 本帧频谱通量

    raw: [0, 0, 0],       // 三个频段的原始能量
    peakDb: [-200, -200, -200], // 自适应增益记住的峰值（分贝）
    bands: [0, 0, 0],     // 最终输出：低、中、高，0~1
    silentFor: 0,         // 已经安静了多少秒
  };

  // ---- 建立音频环境（必须在用户点击之后调用，浏览器才允许出声/收音） ----
  async function ensureContext() {
    if (!s.ctx) {
      s.ctx = new AudioContext();
      s.analyser = s.ctx.createAnalyser();
      s.analyser.fftSize = CONFIG.audio.fftSize;
      s.analyser.smoothingTimeConstant = 0; // 关掉内置平滑：通量需要“原始”的帧间变化，平滑我们自己做
      s.db = new Float32Array(s.analyser.frequencyBinCount);
      s.prevNorm = new Float32Array(s.analyser.frequencyBinCount);
    }
    if (s.ctx.state === 'suspended') await s.ctx.resume();
  }

  function disconnectSource() {
    if (s.source) { s.source.disconnect(); s.source = null; }
    if (s.stream) { s.stream.getTracks().forEach((t) => t.stop()); s.stream = null; }
    if (s.testTimer) { clearInterval(s.testTimer); s.testTimer = null; }
    if (s.cleanup) { s.cleanup(); s.cleanup = null; }
  }

  // ---- 麦克风 ----
  async function startMic() {
    await ensureContext();
    disconnectSource();
    s.mode = 'off';   // 先标记为关闭：如果下面请求权限失败，状态也是对的
    // 三个处理全部关掉：它们是为通话设计的，会把音乐当噪声压掉、把音量自动拉平
    s.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,  // 回声消除
        noiseSuppression: false,  // 降噪
        autoGainControl: false,   // 自动增益
      },
      video: false,
    });
    s.trackSettings = s.stream.getAudioTracks()[0].getSettings();
    s.source = s.ctx.createMediaStreamSource(s.stream);
    s.source.connect(s.analyser);   // 只接分析器，不接扬声器，避免啸叫
    s.mode = 'mic';
    resetAnalysis();
  }

  // ---- 测试信号：一段 122 BPM 的合成节奏，用来在没有麦克风时检验整条链路 ----
  async function startTest() {
    await ensureContext();
    disconnectSource();
    const ctx = s.ctx;
    const bus = ctx.createGain();
    bus.connect(s.analyser);
    const speaker = ctx.createGain();
    speaker.gain.value = CONFIG.audio.testSignalVolume;
    bus.connect(speaker);
    speaker.connect(ctx.destination);
    s.source = bus;

    // 白噪声素材（给军鼓和镲片用）
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    const bpm = 122;
    const step = 60 / bpm / 2;      // 八分音符
    let nextTime = ctx.currentTime + 0.1;
    let stepIndex = 0;

    function kick(t) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(bus);
      o.start(t); o.stop(t + 0.45);
    }
    function noiseHit(t, type, freq, dur, level) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(bus);
      src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
    }
    // 持续的中频和弦，音量缓慢起伏
    const pad = ctx.createGain();
    pad.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    lfo.frequency.value = 0.07; lfoAmt.gain.value = 0.045;
    lfo.connect(lfoAmt).connect(pad.gain);
    lfo.start();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400;
    for (const f of [220, 277.2, 329.6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start();
    }
    lp.connect(pad).connect(bus);

    // 调度器：每 25ms 检查一次，把未来 0.12 秒内的音符提前安排好（避免定时器抖动）
    s.testTimer = setInterval(() => {
      while (nextTime < ctx.currentTime + 0.12) {
        const i = stepIndex % 8;
        if (i % 2 === 0) kick(nextTime);                                  // 每拍底鼓
        if (i === 2 || i === 6) noiseHit(nextTime, 'bandpass', 1800, 0.18, 0.5); // 2、4 拍军鼓
        if (i % 2 === 1) noiseHit(nextTime, 'highpass', 7000, 0.05, 0.35);  // 反拍镲片
        nextTime += step;
        stepIndex++;
      }
    }, 25);
    // 停止时要额外关掉的东西
    s.cleanup = () => { lfo.stop(); lp.disconnect(); pad.disconnect(); speaker.disconnect(); };

    s.mode = 'test';
    resetAnalysis();
  }

  function stop() {
    disconnectSource();
    s.mode = 'off';
    resetAnalysis();
  }

  function resetAnalysis() {
    s.peakDb = [-200, -200, -200];
    s.bands = [0, 0, 0];
    s.flux = 0;
    if (s.prevNorm) s.prevNorm.fill(0);
  }

  // 页面隐藏时挂起音频处理，回来时恢复
  function setPaused(paused) {
    if (!s.ctx) return;
    if (paused) s.ctx.suspend();
    else if (s.mode !== 'off') s.ctx.resume();
  }

  // ---- 每帧分析 ----
  function update(dt) {
    if (s.mode === 'off' || !s.analyser) {
      // 没有声音：三个频段慢慢回到 0
      for (let b = 0; b < 3; b++) s.bands[b] *= Math.exp(-dt / 0.5);
      s.flux = 0;
      s.silentFor += dt;
      return;
    }
    const a = CONFIG.audio;
    const bc = CONFIG.beat;
    s.analyser.getFloatFrequencyData(s.db);     // 每个频率格子（bin）的分贝值
    const binHz = s.ctx.sampleRate / s.analyser.fftSize; // 每个格子代表多少 Hz
    const ranges = [a.lowBand, a.midBand, a.highBand];

    // 1) 三个频段的能量：频段内所有格子的平均功率
    for (let b = 0; b < 3; b++) {
      const i0 = Math.max(1, Math.floor(ranges[b][0] / binHz));
      const i1 = Math.min(s.db.length - 1, Math.ceil(ranges[b][1] / binHz));
      let sum = 0;
      for (let i = i0; i <= i1; i++) {
        const mag = Math.pow(10, s.db[i] / 20);   // 分贝 -> 线性振幅
        sum += mag * mag;
      }
      s.raw[b] = sum / (i1 - i0 + 1);
    }

    // 2) 自适应增益（在分贝域里做，更接近人耳对响度的感受）+ 3) attack/release 平滑
    let loud = false;
    for (let b = 0; b < 3; b++) {
      const levelDb = 10 * Math.log10(s.raw[b] + 1e-12);     // 功率 -> 分贝
      // 峰值：遇到更响的立刻更新，否则每秒回落 peakFallDb；
      // 且不低于“噪声门 + 半个动态范围”，避免刚过门限的底噪被放大成满格
      s.peakDb[b] = Math.max(levelDb, s.peakDb[b] - a.peakFallDb * dt, a.gateDb + a.rangeDb * 0.5);
      let target = 0;
      if (levelDb > a.gateDb) {
        loud = true;
        target = Math.min(Math.max(1 - (s.peakDb[b] - levelDb) / a.rangeDb, 0), 1);
      }
      const tau = target > s.bands[b] ? a.attack[b] : a.release[b];
      s.bands[b] += (target - s.bands[b]) * (1 - Math.exp(-dt / tau));
    }
    s.silentFor = loud ? 0 : s.silentFor + dt;

    // 4) 频谱通量：把每个格子的分贝映射到 0~1，只累加“变响”的部分（变轻的不算）
    const maxBin = Math.min(s.db.length, Math.ceil(12000 / binHz));
    let flux = 0;
    for (let i = 1; i < maxBin; i++) {
      const n = Math.min(Math.max((s.db[i] - bc.fluxMinDb) / (bc.fluxMaxDb - bc.fluxMinDb), 0), 1);
      const d = n - s.prevNorm[i];
      if (d > 0) flux += d;
      s.prevNorm[i] = n;
    }
    s.flux = flux / maxBin;
  }

  return { state: s, startMic, startTest, stop, update, setPaused };
}

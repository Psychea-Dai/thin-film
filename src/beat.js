// =============================================================================
// beat.js —— 起拍检测、BPM、节拍网格、LFO 呼吸（D 阶段）
//
//  起拍（onset）：频谱通量突然高出“最近的平常水平”很多 -> 认为来了一个鼓点 -> 触发脉冲
//  BPM 来源（四选一）：关 / 自动（实验）/ Tap 手动点按 / 手动输入
//  有 BPM 时：节拍网格（beat grid）按拍子产生较弱的脉冲，并慢慢对齐真实鼓点
//  没有声音时：LFO（低频振荡器）让画面缓慢呼吸；有 BPM 时呼吸与拍子同步
// =============================================================================
import { CONFIG } from './config.js';

const now = () => performance.now() / 1000; // 秒

export function createBeat() {
  const s = {
    fluxHist: [],         // 最近约 0.75 秒的通量，用来算“平常水平”
    prevFlux: 0,
    threshold: 0,         // 当前阈值（给界面显示）
    lastOnset: -1e9,
    onsets: [],           // 最近的起拍时间
    onsetPulse: 0,        // 鼓点脉冲 0~1

    autoBpm: 0,           // 自动估计的 BPM（0 = 还没估出来）
    autoConfidence: 0,    // 置信度，大约 1 = 不确定，>2 = 比较确定
    candidate: 0, candidateHits: 0,
    nextEstimate: 0,

    taps: [],
    tapBpm: 0,
    manualBpm: 120,
    tempoSource: 'off',   // 'off' | 'auto' | 'tap' | 'manual'

    phase: 0,             // 节拍网格的相位，每过一拍 +1
    gridPulse: 0,

    breathPhase: 0,       // LFO 相位（0~1 为一次呼吸）
    lfoMix: 1,            // LFO 在画面里的占比：1 = 完全由呼吸驱动
    pulse: 0,             // 最终脉冲输出
  };

  // 当前生效的 BPM（0 = 没有）
  function bpm() {
    if (s.tempoSource === 'auto') return s.autoBpm;
    if (s.tempoSource === 'tap') return s.tapBpm;
    if (s.tempoSource === 'manual') return s.manualBpm;
    return 0;
  }

  // ---- Tap tempo：按下时调用 ----
  function tap() {
    const t = now();
    if (s.taps.length && t - s.taps[s.taps.length - 1] > 2) s.taps = []; // 停顿超过 2 秒就重新开始
    s.taps.push(t);
    if (s.taps.length > 8) s.taps.shift();
    if (s.taps.length >= 2) {
      const span = s.taps[s.taps.length - 1] - s.taps[0];
      s.tapBpm = Math.round((60 * (s.taps.length - 1)) / span * 10) / 10;
    }
    s.phase = Math.round(s.phase);   // 点按的那一刻就是一拍的开头
    s.tempoSource = 'tap';
  }

  // ---- 自动 BPM（实验）：对所有起拍两两之间的时间间隔做“梳状打分” ----
  // 对每个候选 BPM，看这些间隔有多少恰好是它的 1~4 拍。得分最高的就是估计值。
  function estimateBpm(t) {
    const c = CONFIG.beat;
    s.onsets = s.onsets.filter((x) => t - x < c.bpmWindow);
    if (s.onsets.length < 6) return;
    const iois = [];
    for (let i = 0; i < s.onsets.length; i++) {
      for (let j = i + 1; j < s.onsets.length; j++) {
        const d = s.onsets[j] - s.onsets[i];
        if (d > 0.2 && d < 2.6) iois.push(d);
      }
    }
    let best = 0, bestScore = 0, total = 0, count = 0;
    for (let b = c.bpmRange[0]; b <= c.bpmRange[1]; b += 0.5) {
      const T = 60 / b;
      let score = 0;
      for (const d of iois) {
        const k = Math.round(d / T);
        if (k < 1 || k > 4) continue;
        const err = d - k * T;
        score += Math.exp(-(err * err) / (2 * 0.02 * 0.02)) / Math.sqrt(k);
      }
      total += score; count++;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (!best) return;
    s.autoConfidence = bestScore / (total / count);
    // 防抖：新的估计与旧值差很多时，要连续出现两次才采纳
    if (!s.autoBpm || Math.abs(best - s.autoBpm) < 3) {
      s.autoBpm = s.autoBpm ? s.autoBpm * 0.7 + best * 0.3 : best;
      s.candidateHits = 0;
    } else if (Math.abs(best - s.candidate) < 3 && ++s.candidateHits >= 2) {
      s.autoBpm = best;
      s.candidateHits = 0;
    } else if (Math.abs(best - s.candidate) >= 3) {
      s.candidate = best;
      s.candidateHits = 1;
    }
  }

  // ---- 每帧调用 ----
  // flux：本帧频谱通量；audioOn：是否有音源；silentFor：已安静秒数
  function update(dt, flux, audioOn, silentFor) {
    const c = CONFIG.beat;
    const t = now();

    // 1) 起拍检测：阈值 = 近期平均 + threshold × 标准差
    let onset = false;
    if (audioOn) {
      const h = s.fluxHist;
      let mean = 0;
      for (const v of h) mean += v;
      mean /= Math.max(h.length, 1);
      let variance = 0;
      for (const v of h) variance += (v - mean) * (v - mean);
      const std = Math.sqrt(variance / Math.max(h.length, 1));
      s.threshold = Math.max(mean + c.threshold * std, c.minFlux);

      if (h.length > 10 && flux > s.threshold && flux > s.prevFlux && t - s.lastOnset > c.minInterval) {
        onset = true;
        s.lastOnset = t;
        s.onsets.push(t);
        // 超出阈值越多，脉冲越强
        const strength = Math.min(0.45 + (flux - s.threshold) / s.threshold, 1);
        s.onsetPulse = Math.max(s.onsetPulse, strength);
      }
      h.push(flux);
      if (h.length > 45) h.shift();
      s.prevFlux = flux;
    }
    s.onsetPulse *= Math.exp(-dt / c.pulseDecay);

    // 2) 自动 BPM：每半秒算一次就够了
    if (audioOn && t > s.nextEstimate) {
      estimateBpm(t);
      s.nextEstimate = t + 0.5;
    }

    // 3) 节拍网格
    const b = bpm();
    if (b > 0) {
      const before = Math.floor(s.phase);
      s.phase += (dt * b) / 60;
      if (Math.floor(s.phase) !== before) s.gridPulse = 1;  // 跨过整数 = 新的一拍
      // 软对齐：鼓点出现在某拍附近时，把相位往那一拍拉一点
      if (onset) {
        const err = s.phase - Math.round(s.phase);
        if (Math.abs(err) < 0.25) s.phase -= err * c.phaseLock;
      }
    }
    s.gridPulse *= Math.exp(-dt / c.pulseDecay);

    // 4) LFO 呼吸：没声音时占满，有声音时只留一点
    const silent = !audioOn || silentFor > CONFIG.audio.silenceTime;
    const mixTarget = silent ? 1 : 0.25;
    s.lfoMix += (mixTarget - s.lfoMix) * (1 - Math.exp(-dt / 1.5));
    // 呼吸周期：有 BPM 时 = 16 拍（四小节，120 BPM 时 8 秒），否则用 CONFIG 里的周期。
    // 相位是累加出来的，周期改变时呼吸只会变快变慢，不会跳
    const period = b > 0 ? (60 / b) * 16 : CONFIG.motion.breathPeriod;
    s.breathPhase = (s.breathPhase + dt / period) % 1;

    s.pulse = Math.max(s.onsetPulse, s.gridPulse * c.gridPulse);
    return onset;
  }

  // LFO 输出：-1 ~ 1 的正弦
  function breath() {
    return Math.sin(s.breathPhase * Math.PI * 2);
  }

  return { state: s, update, tap, bpm, breath };
}

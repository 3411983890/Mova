/**
 * 负责：用 Web Audio API 程序化合成 Mova 60 秒宣传片的全部 UI 交互音效与低频环境铺底，并支持离线渲染导出 48kHz WAV。
 * 不负责：不控制画面时间轴或 DOM 状态，也不加载任何外部音频资源。
 * 被谁调用：`docs/prototypes/promo/index.html`（挂在 `window.MovaAudio` 上供 `promo.js` 与 `scripts/probes/record-promo.cjs` 调用）。
 */
(function () {
  'use strict';

  const DURATION = 60;
  const noiseCache = new WeakMap();

  function noise(ctx) {
    let buf = noiseCache.get(ctx);
    if (!buf) {
      buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 1337;
      for (let i = 0; i < d.length; i++) { seed = (seed * 16807) % 2147483647; d[i] = (seed / 2147483647) * 2 - 1; }
      noiseCache.set(ctx, buf);
    }
    return buf;
  }

  function env(g, at, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  function osc(ctx, out, type, f0, f1, at, dur, peak, attack = 0.004) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    env(g, at, peak, attack, dur);
    o.connect(g).connect(out);
    o.start(at); o.stop(at + attack + dur + 0.05);
    return o;
  }

  function burst(ctx, out, at, dur, peak, filterType, f0, f1, q = 1, attack = 0.003) {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.Q.value = q;
    f.frequency.setValueAtTime(f0, at);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ctx.createGain();
    env(g, at, peak, attack, dur);
    s.connect(f).connect(g).connect(out);
    s.start(at, (at * 7.31) % 1.5); s.stop(at + attack + dur + 0.05);
    return s;
  }

  const SYNTH = {
    // 极轻的键盘/数据粒子
    tick: (c, o, at, v = 1) => osc(c, o, 'sine', 3200, 2600, at, 0.018, 0.028 * v, 0.001),
    type: (c, o, at, v = 1) => burst(c, o, at, 0.018, 0.05 * v, 'bandpass', 3800, 3800, 2.5, 0.001),
    // 拨动开关式点击
    click: (c, o, at, v = 1) => { burst(c, o, at, 0.03, 0.16 * v, 'highpass', 2400, 2400, 0.7, 0.001); osc(c, o, 'sine', 1900, 1200, at, 0.03, 0.06 * v, 0.001); },
    pop: (c, o, at, v = 1) => osc(c, o, 'sine', 520, 880, at, 0.09, 0.09 * v, 0.003),
    // 空气掠过
    whoosh: (c, o, at, v = 1, dur = 0.7) => burst(c, o, at, dur, 0.12 * v, 'bandpass', 260, 2600, 0.9, dur * 0.45),
    whooshDown: (c, o, at, v = 1, dur = 0.8) => burst(c, o, at, dur, 0.1 * v, 'bandpass', 2400, 240, 0.9, dur * 0.35),
    // 低频落点
    boom: (c, o, at, v = 1) => { osc(c, o, 'sine', 82, 38, at, 1.3, 0.55 * v, 0.006); burst(c, o, at, 0.5, 0.08 * v, 'lowpass', 400, 120, 0.7, 0.004); },
    // 心跳式脉冲（60 BPM 底层节奏）
    pulse: (c, o, at, v = 1) => osc(c, o, 'sine', 56, 40, at, 0.42, 0.26 * v, 0.008),
    // 共鸣确认
    chime: (c, o, at, v = 1) => { [660, 990, 1320, 1980].forEach((f, i) => osc(c, o, 'sine', f, f, at + i * 0.012, 1.6 - i * 0.25, (0.07 - i * 0.012) * v, 0.004)); },
    // 水晶单音（开场光环）
    crystal: (c, o, at, v = 1) => { osc(c, o, 'sine', 1568, 1568, at, 2.4, 0.06 * v, 0.02); osc(c, o, 'sine', 2349, 2349, at + 0.02, 1.8, 0.025 * v, 0.02); osc(c, o, 'triangle', 784, 784, at, 2.6, 0.03 * v, 0.05); },
    blink: (c, o, at, v = 1) => osc(c, o, 'sine', 1200, 1700, at, 0.05, 0.035 * v, 0.002),
    // 快门 / 拾取
    shutter: (c, o, at, v = 1) => { SYNTH.click(c, o, at, 0.8 * v); SYNTH.click(c, o, at + 0.045, 0.55 * v); },
    // 弹簧阻尼摩擦
    spring: (c, o, at, v = 1, dur = 0.9) => { burst(c, o, at, dur, 0.05 * v, 'bandpass', 700, 300, 4, dur * 0.3); osc(c, o, 'sine', 180, 120, at, dur, 0.04 * v, 0.05); },
    // 保险库合拢
    lock: (c, o, at, v = 1) => { burst(c, o, at, 0.08, 0.2 * v, 'bandpass', 1500, 900, 3, 0.001); osc(c, o, 'square', 160, 110, at, 0.12, 0.05 * v, 0.001); osc(c, o, 'sine', 70, 45, at + 0.01, 0.9, 0.4 * v, 0.004); },
    shimmer: (c, o, at, v = 1) => { [1046, 1318, 1568, 2093].forEach((f, i) => osc(c, o, 'sine', f, f, at + i * 0.07, 0.9, 0.03 * v, 0.01)); },
  };

  // 持续的暗色铺底：两组失谐低音 + 低通，随段落起伏。
  function drone(ctx, out, from, startAt) {
    const nodes = [];
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
    const g = ctx.createGain();
    lp.connect(g).connect(out);
    // 包络断点（时间, 音量）
    const pts = [[0, 0.0001], [3, 0.05], [7, 0.09], [42, 0.1], [53, 0.07], [56.5, 0.11], [59.2, 0.04], [60, 0.0001]];
    const valueAt = (t) => {
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) { const [t0, v0] = pts[i - 1]; const [t1, v1] = pts[i]; return v0 + (v1 - v0) * ((t - t0) / (t1 - t0)); }
      }
      return 0.0001;
    };
    g.gain.setValueAtTime(Math.max(0.0001, valueAt(from)), startAt);
    pts.forEach(([t, v]) => { if (t > from) g.gain.linearRampToValueAtTime(v, startAt + (t - from)); });
    [[55, -6], [55, 7], [82.4, 0], [110, 3]].forEach(([f, det], i) => {
      const o = ctx.createOscillator();
      o.type = i < 2 ? 'sawtooth' : 'sine';
      o.frequency.value = f; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = i < 2 ? 0.18 : 0.5;
      o.connect(og).connect(lp);
      o.start(startAt); o.stop(startAt + Math.max(0.1, DURATION - from));
      nodes.push(o);
    });
    return nodes;
  }

  function master(ctx, dest) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    const g = ctx.createGain(); g.gain.value = 0.9;
    comp.connect(g).connect(dest);
    return { input: comp, gain: g };
  }

  /** 从时间 from（秒）开始排程，返回可 stop() 的句柄。 */
  function schedule(ctx, dest, from, cues) {
    const m = master(ctx, dest);
    // 离线渲染从 0 开始；实时播放留 50ms 余量，画面时钟以 startAt 为准（见 promo.js）。
    const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    const startAt = offline ? 0 : ctx.currentTime + 0.05;
    const nodes = drone(ctx, m.input, from, startAt);
    for (const cue of cues) {
      if (cue.t < from - 0.001) continue;
      const fn = SYNTH[cue.s];
      if (fn) fn(ctx, m.input, startAt + (cue.t - from), cue.v ?? 1, cue.d);
    }
    return {
      startAt,
      stop() {
        try { m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch { /* ignore */ }
        nodes.forEach((n) => { try { n.stop(ctx.currentTime + 0.2); } catch { /* ignore */ } });
        setTimeout(() => { try { m.gain.disconnect(); } catch { /* ignore */ } }, 400);
      },
    };
  }

  function encodeWav(audioBuffer) {
    const ch = audioBuffer.numberOfChannels, sr = audioBuffer.sampleRate, len = audioBuffer.length;
    const buf = new ArrayBuffer(44 + len * ch * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(audioBuffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return buf;
  }

  async function renderWav(cues, sampleRate = 48000) {
    const ctx = new OfflineAudioContext(2, sampleRate * DURATION, sampleRate);
    schedule(ctx, ctx.destination, 0, cues);
    const rendered = await ctx.startRendering();
    return encodeWav(rendered);
  }

  window.MovaAudio = { schedule, renderWav, DURATION };
})();

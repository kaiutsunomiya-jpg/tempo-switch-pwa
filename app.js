(() => {
  'use strict';

  const STORAGE_KEY = 'tempo-switch-settings-v1';
  const LETTERS = ['A', 'B', 'C'];
  const MIN_BPM = 30;
  const MAX_BPM = 300;
  // 120 → 100 → 120 → 100 → 120 → 100 → 120 → 100 → 120 → 110
  const DEFAULT_SEQUENCE = ['B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'C'];
  const DEFAULT_PRESETS = { A: 100, B: 120, C: 110 };

  const $ = (selector) => document.querySelector(selector);
  const els = {
    seqList: $('#sequence-list'), seqCount: $('#sequence-count'),
    undo: $('#undo-btn'), clear: $('#clear-btn'),
    status: $('#playback-status'), current: $('#current-tempo'),
    currentLetter: $('#current-letter'), currentBpm: $('#current-bpm'),
    stepProgress: $('#step-progress'), beatDots: [...document.querySelectorAll('#beat-dots i')],
    nextCaption: $('#next-caption'), wrapNote: $('#wrap-note'),
    advance: $('#advance-btn'), actionLabel: $('#action-label'),
    actionDetail: $('#action-detail'), actionArrow: $('#action-arrow'),
    stop: $('#stop-btn'), sound: $('#sound-btn'),
    soundLabel: $('#sound-label'), soundIcon: $('#sound-icon'),
    announcement: $('#screenreader-announcement'),
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== 'object') return null;
      const presets = {};
      for (const letter of LETTERS) {
        const bpm = saved.presets?.[letter];
        presets[letter] = Number.isInteger(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM
          ? bpm : DEFAULT_PRESETS[letter];
      }
      const sequence = Array.isArray(saved.sequence)
        ? saved.sequence.filter((letter) => LETTERS.includes(letter)).slice(0, 256)
        : [...DEFAULT_SEQUENCE];
      return { presets, sequence, soundOn: saved.soundOn !== false };
    } catch (_) {
      return null;
    }
  }

  const saved = loadSettings();
  const state = {
    presets: saved?.presets ?? { ...DEFAULT_PRESETS },
    sequence: saved?.sequence ?? [...DEFAULT_SEQUENCE],
    soundOn: saved?.soundOn ?? true,
    playing: false,
    currentIndex: -1,
  };
  const undoHistory = [];

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        presets: state.presets,
        sequence: state.sequence,
        soundOn: state.soundOn,
      }));
    } catch (_) {
      // App still works when storage is blocked (e.g. private browsing).
    }
  }

  // AUDIO: Web Audio's short lookahead avoids the drift of setInterval-only clicks.
  // On each advance, previously scheduled clicks are cancelled, and the new
  // BPM's first beat is scheduled ~15 ms after the tap.
  let audioContext = null;
  let schedulerTimer = null;
  let beatTime = 0;
  let beatIndex = 0;
  let audioRequestId = 0;
  let clockId = 0;
  let wakeLock = null;
  const soundNodes = new Set();
  const visualTimers = new Set();

  function clearVisuals() {
    for (const timer of visualTimers) clearTimeout(timer);
    visualTimers.clear();
    els.beatDots.forEach((dot) => dot.classList.remove('active'));
  }

  function stopQueuedSounds() {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    for (const node of [...soundNodes]) {
      try {
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(0.00001, now);
        node.oscillator.stop(now + 0.003);
      } catch (_) {
        // An oscillator may already have finished.
      }
      soundNodes.delete(node);
    }
  }

  function makeClick(time, accented) {
    if (!state.soundOn || !audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(accented ? 1530 : 1050, time);
    oscillator.frequency.exponentialRampToValueAtTime(accented ? 940 : 690, time + 0.045);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accented ? 0.46 : 0.29, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.057);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    const node = { oscillator, gain };
    soundNodes.add(node);
    oscillator.onended = () => {
      soundNodes.delete(node);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(time);
    oscillator.stop(time + 0.06);
  }

  function queueVisualBeat(time, ordinal, generation) {
    const delay = Math.max(0, (time - audioContext.currentTime) * 1000);
    const timer = setTimeout(() => {
      visualTimers.delete(timer);
      if (!state.playing || generation !== clockId) return;
      els.beatDots.forEach((dot, index) => dot.classList.toggle('active', index === ordinal));
      const offTimer = setTimeout(() => {
        visualTimers.delete(offTimer);
        if (generation === clockId) els.beatDots[ordinal].classList.remove('active');
      }, 95);
      visualTimers.add(offTimer);
    }, delay);
    visualTimers.add(timer);
  }

  function scheduleBeats() {
    if (!state.playing || !audioContext || audioContext.state !== 'running') return;
    const letter = state.sequence[state.currentIndex];
    if (!letter) return;
    const interval = 60 / state.presets[letter];
    const generation = clockId;
    // Schedule only 90 ms ahead. This is short enough for instant BPM changes.
    while (beatTime < audioContext.currentTime + 0.09) {
      const ordinal = beatIndex % 4;
      makeClick(beatTime, ordinal === 0);
      queueVisualBeat(beatTime, ordinal, generation);
      beatTime += interval;
      beatIndex++;
    }
  }

  function restartClock() {
    if (schedulerTimer !== null) clearInterval(schedulerTimer);
    schedulerTimer = null;
    ++clockId;
    clearVisuals();
    stopQueuedSounds();
    if (!state.playing || !audioContext || audioContext.state !== 'running') return;
    beatTime = audioContext.currentTime + 0.015;
    beatIndex = 0;
    scheduleBeats();
    schedulerTimer = setInterval(scheduleBeats, 25);
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || !state.playing || document.hidden) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch (_) { /* Browser may not support it or permission may be denied. */ }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }

  async function startAudio() {
    const request = ++audioRequestId;
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Web Audio API is unsupported');
        audioContext = new AudioContextClass();
      }
      if (audioContext.state !== 'running') await audioContext.resume();
      if (request !== audioRequestId || !state.playing) return;
      restartClock();
    } catch (_) {
      if (request !== audioRequestId) return;
      stopPlayback();
      els.announcement.textContent = '音声を再生できませんでした。ブラウザーの音声設定を確認してください。';
    }
  }

  function stopPlayback() {
    ++audioRequestId;
    state.playing = false;
    state.currentIndex = -1;
    if (schedulerTimer !== null) clearInterval(schedulerTimer);
    schedulerTimer = null;
    ++clockId;
    clearVisuals();
    stopQueuedSounds();
    releaseWakeLock();
    render();
  }

  function advance() {
    if (!state.sequence.length) return;
    state.currentIndex = state.playing
      ? (state.currentIndex + 1) % state.sequence.length : 0;
    state.playing = true;
    render();
    const letter = state.sequence[state.currentIndex];
    els.announcement.textContent = `${letter}、${state.presets[letter]} BPM、${state.currentIndex + 1}番目`; 
    void acquireWakeLock();
    if (audioContext?.state === 'running') {
      ++audioRequestId;
      restartClock();
    } else {
      void startAudio();
    }
  }

  function updatePreset(letter, nextBpm) {
    if (!LETTERS.includes(letter) || !Number.isInteger(nextBpm)) return false;
    if (nextBpm < MIN_BPM || nextBpm > MAX_BPM) return false;
    if (state.presets[letter] === nextBpm) return true;
    state.presets[letter] = nextBpm;
    saveSettings();
    render();
    if (state.playing && state.sequence[state.currentIndex] === letter) {
      if (audioContext?.state === 'running') restartClock();
      else void startAudio();
    }
    return true;
  }

  function changeSequence(nextSequence) {
    if (nextSequence.length > 256) {
      els.announcement.textContent = 'シーケンスは最大256ステップです。';
      return;
    }
    undoHistory.push([...state.sequence]);
    if (undoHistory.length > 40) undoHistory.shift();
    // Editing an active playlist resets it so the next step is unambiguous.
    if (state.playing) stopPlayback();
    state.sequence = nextSequence;
    saveSettings();
    render();
  }

  function undo() {
    if (!undoHistory.length) return;
    if (state.playing) stopPlayback();
    state.sequence = undoHistory.pop();
    saveSettings();
    render();
  }

  function renderPresets() {
    for (const letter of LETTERS) {
      const input = $(`#bpm${letter}`);
      if (document.activeElement !== input) input.value = state.presets[letter];
    }
  }

  function renderSequence() {
    const fragment = document.createDocumentFragment();
    if (!state.sequence.length) {
      const placeholder = document.createElement('span');
      placeholder.className = 'sequence-empty';
      placeholder.textContent = '下の ＋A / ＋B / ＋C から追加してください';
      fragment.appendChild(placeholder);
    }
    const nextIndex = state.playing
      ? (state.currentIndex + 1) % state.sequence.length : 0;
    state.sequence.forEach((letter, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'seq-chip';
      chip.dataset.letter = letter;
      chip.setAttribute('aria-label', `${i + 1}番目、${letter}、${state.presets[letter]} BPM。タップして削除`);
      chip.title = `${i + 1}番目の ${letter} を削除`;
      if (state.playing && i === state.currentIndex) chip.classList.add('is-current');
      else if (i === nextIndex) chip.classList.add('is-next');
      const number = document.createElement('span');
      number.className = 'seq-number';
      number.textContent = `${i + 1}`;
      const name = document.createElement('span');
      name.className = 'seq-name';
      name.textContent = letter;
      chip.append(number, name);
      chip.addEventListener('click', () => {
        changeSequence(state.sequence.filter((_, index) => index !== i));
      });
      fragment.appendChild(chip);
    });
    els.seqList.replaceChildren(fragment);
    els.seqCount.textContent = `${state.sequence.length} STEPS`;
    els.undo.disabled = undoHistory.length === 0;
    els.clear.disabled = state.sequence.length === 0;
  }

  function renderLive() {
    const total = state.sequence.length;
    const nextIndex = !total ? -1 : (state.playing ? (state.currentIndex + 1) % total : 0);
    const nextLetter = nextIndex === -1 ? null : state.sequence[nextIndex];
    const currentLetter = state.playing ? state.sequence[state.currentIndex] : null;

    els.status.classList.toggle('is-playing', state.playing);
    els.status.lastChild.textContent = state.playing ? '再生中' : '停止中';
    els.currentLetter.textContent = currentLetter ?? '—';
    els.currentBpm.textContent = currentLetter ? state.presets[currentLetter] : '—';
    if (currentLetter) els.current.dataset.letter = currentLetter;
    else delete els.current.dataset.letter;
    els.stepProgress.textContent = `${state.playing ? state.currentIndex + 1 : 0} / ${total}`;

    els.nextCaption.textContent = nextLetter ? `${nextLetter} · ${state.presets[nextLetter]} BPM` : '未設定';
    els.wrapNote.textContent = state.playing && nextIndex === 0 ? '↺ 先頭へ' : '';
    els.advance.dataset.letter = nextLetter ?? '';
    els.advance.disabled = !total;
    els.actionLabel.textContent = !total ? '順番を設定してください' : state.playing ? '次のテンポへ' : '再生スタート';
    els.actionDetail.textContent = nextLetter ? `${nextLetter} · ${state.presets[nextLetter]} BPM` : '＋A / ＋B / ＋C';
    els.actionArrow.textContent = state.playing ? '→' : '▶';
    els.advance.setAttribute('aria-label', !total ? 'シーケンスが空です' :
      `${state.playing ? '次へ切り替え' : '再生開始'}、${nextLetter}、${state.presets[nextLetter]} BPM`);
    els.stop.disabled = !state.playing;
    els.sound.setAttribute('aria-pressed', String(state.soundOn));
    els.soundLabel.textContent = state.soundOn ? '音 ON' : '音 OFF';
    els.soundIcon.textContent = state.soundOn ? '♫' : '♪';
  }

  function render() {
    renderPresets();
    renderSequence();
    renderLive();
  }

  document.querySelectorAll('[data-adjust]').forEach((button) => {
    button.addEventListener('click', () => {
      const letter = button.dataset.adjust;
      const delta = Number(button.dataset.delta);
      updatePreset(letter, Math.max(MIN_BPM, Math.min(MAX_BPM, state.presets[letter] + delta)));
    });
  });

  for (const letter of LETTERS) {
    const input = $(`#bpm${letter}`);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!updatePreset(letter, value)) {
        input.value = state.presets[letter];
        els.announcement.textContent = 'BPMは30から300までの整数で入力してください。';
      }
    });
    input.addEventListener('blur', () => { input.value = state.presets[letter]; });
  }

  document.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => changeSequence([...state.sequence, button.dataset.add]));
  });
  els.undo.addEventListener('click', undo);
  els.clear.addEventListener('click', () => {
    if (state.sequence.length) changeSequence([]);
  });
  els.advance.addEventListener('click', advance);
  els.stop.addEventListener('click', stopPlayback);
  els.sound.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    if (!state.soundOn) stopQueuedSounds();
    saveSettings();
    renderLive();
  });

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' && event.code !== 'Escape') return;
    if (event.target instanceof HTMLElement && (
      event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT'].includes(event.target.tagName)
    )) return;
    if (event.repeat) return;
    if (event.code === 'Space') { event.preventDefault(); advance(); }
    if (event.code === 'Escape' && state.playing) { event.preventDefault(); stopPlayback(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) wakeLock = null;
    else if (state.playing) void acquireWakeLock();
  });
  window.addEventListener('pagehide', () => { if (state.playing) stopPlayback(); });

  render();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // Offline support is optional; the metronome still works online.
      });
    });
  }
})();

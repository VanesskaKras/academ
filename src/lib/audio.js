const CUSTOM_SOUND_URL = "/sounds/hi.mp3"; // або "/sounds/done.mp3"

function _playAudioNow() {
  if (CUSTOM_SOUND_URL) {
    try { new Audio(CUSTOM_SOUND_URL).play(); } catch { }
    return;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
  } catch { }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function playDoneSound() {}

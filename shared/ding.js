// Short two-tone "ding" made with the Web Audio API (no sound file needed).
// Used for FALSE-claim alerts and by the settings page's "Test sound" button.
self.factflagDing = function factflagDing() {
  try {
    const Ctx = self.AudioContext || self.webkitAudioContext;
    if (!Ctx) return false;
    const ctx = self.__factflagAudio || (self.__factflagAudio = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    for (const [freq, delay] of [[880, 0], [1320, 0.13]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.65);
    }
    return true;
  } catch (_) {
    return false;
  }
};

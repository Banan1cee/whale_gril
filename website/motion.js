(function (scope) {
  'use strict';
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  function reveal(top, height, viewport) {
    const enter = ease((viewport - top) / (viewport * 0.28));
    const leave = ease((top + height) / (viewport * 0.18));
    return { opacity: 0.25 + 0.75 * Math.min(enter, leave), y: (1 - enter) * 48 - (1 - leave) * 20, scale: 0.975 + enter * 0.025 };
  }
  function story(top, height, viewport) {
    const progress = clamp(-top / Math.max(1, height - viewport));
    return {
      progress,
      entrance: ease((viewport * 0.85 - top) / (viewport * 0.75)),
      stage: Math.min(2, Math.floor(progress * 3)),
      x: Math.sin(progress * Math.PI * 2) * 12,
      y: -Math.sin(progress * Math.PI) * 18,
      rotate: -3 + progress * 6,
      scale: 0.96 + Math.sin(progress * Math.PI) * 0.04,
    };
  }
  const motion = { reveal, story };
  if (typeof module === 'object' && module.exports) module.exports = motion;
  else scope.WhaleMotion = motion;
})(typeof window === 'object' ? window : globalThis);

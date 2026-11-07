'use strict';

const root = document.documentElement;
const themeButton = document.querySelector('#theme-toggle');
const themeMedia = matchMedia('(prefers-color-scheme: light)');
let explicitTheme = false;
try { explicitTheme = ['light', 'dark'].includes(localStorage.getItem('whale-theme')); } catch (_) { /* 存储不可用不影响切换。 */ }
function updateThemeLabel() {
  themeButton.setAttribute('aria-label', root.dataset.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  document.querySelector('meta[name="theme-color"]').content = root.dataset.theme === 'dark' ? '#070b13' : '#ffffff';
}
themeButton.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  explicitTheme = true;
  try { localStorage.setItem('whale-theme', root.dataset.theme); } catch (_) { /* 当前页面仍保留选择。 */ }
  updateThemeLabel();
});
themeMedia.addEventListener('change', event => {
  if (!explicitTheme) { root.dataset.theme = event.matches ? 'light' : 'dark'; updateThemeLabel(); }
});
updateThemeLabel();

const menuButton = document.querySelector('.menu-toggle');
const navLinks = document.querySelector('.nav-links');
function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false');
  navLinks.classList.remove('open');
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  navLinks.classList.toggle('open', open);
});
navLinks.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navLinks.classList.contains('open')) { closeMenu(); menuButton.focus(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.nav')) closeMenu(); });
matchMedia('(min-width: 901px)').addEventListener('change', closeMenu);

const dialog = document.querySelector('#article-dialog');
document.querySelector('[data-article="report"]').addEventListener('click', () => dialog.showModal());
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});

const motionMedia = matchMedia('(prefers-reduced-motion: reduce)');
const motionButton = document.querySelector('#motion-toggle');
let motionPaused = motionMedia.matches;
function updateMotion() {
  root.dataset.motion = motionPaused ? 'paused' : 'running';
  motionButton.setAttribute('aria-pressed', String(motionPaused));
  motionButton.disabled = motionMedia.matches;
  motionButton.textContent = motionMedia.matches ? '静态模式' : motionPaused ? '开启动画 ▷' : '暂停动画 Ⅱ';
  root.classList.toggle('scroll-enhanced', !motionPaused);
  // 下一帧重新计算当前位置，恢复动画时不会停留在暂停前的章节。
  requestAnimationFrame(() => updateProgress());
}
motionButton.addEventListener('click', () => { motionPaused = !motionPaused; updateMotion(); });
motionMedia.addEventListener('change', event => { motionPaused = event.matches; updateMotion(); });
updateMotion();

const revealElements = [...document.querySelectorAll('.reveal')];
const storySection = document.querySelector('.story-section');
const storyCaptions = [...document.querySelectorAll('.story-caption')];
const characterPoses = [...document.querySelectorAll('.character-pose')];
const characterScenes = [...document.querySelectorAll('.character-scene')];
const journey = document.querySelector('.journey');
const activeReveals = new Set(revealElements);
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) activeReveals.add(entry.target);
      else activeReveals.delete(entry.target);
    });
    queueProgress();
  }, { rootMargin: '160px 0px' });
  revealElements.forEach(element => observer.observe(element));
}

const heroArt = document.querySelector('.hero-art');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
heroArt.addEventListener('pointermove', event => {
  if (motionPaused || !finePointer.matches) return;
  const rect = heroArt.getBoundingClientRect();
  heroArt.style.setProperty('--tilt-x', `${((event.clientX - rect.left) / rect.width - 0.5) * 10}deg`);
  heroArt.style.setProperty('--tilt-y', `${((event.clientY - rect.top) / rect.height - 0.5) * -8}deg`);
});
heroArt.addEventListener('pointerleave', () => {
  heroArt.style.setProperty('--tilt-x', '0deg');
  heroArt.style.setProperty('--tilt-y', '0deg');
});

let scrollFrame = 0;
function updateProgress() {
  const range = root.scrollHeight - innerHeight;
  root.style.setProperty('--page-progress', range > 0 ? Math.min(1, Math.max(0, scrollY / range)) : 0);
  if (!motionPaused) {
    // 每次按位置求值，向上和向下滚动使用同一轨迹，不注销观察器。
    const measurements = [...activeReveals].map(element => {
      // offset 几何不包含上一次 transform，避免位置反馈引起抖动。
      let top = 0;
      for (let parent = element; parent; parent = parent.offsetParent) top += parent.offsetTop;
      return { element, rect: { top: top - scrollY, height: element.offsetHeight } };
    });
    const storyRect = storySection.getBoundingClientRect();
    for (const { element, rect } of measurements) {
      const state = WhaleMotion.reveal(rect.top, rect.height, innerHeight);
      element.style.setProperty('--reveal-opacity', state.opacity);
      element.style.setProperty('--reveal-y', `${state.y}px`);
      element.style.setProperty('--reveal-scale', state.scale);
    }
    const state = WhaleMotion.story(storyRect.top, storyRect.height, innerHeight);
    journey.style.setProperty('--handoff', state.entrance);
    storySection.dataset.stage = String(state.stage);
    storySection.style.setProperty('--story-progress', state.progress);
    storySection.style.setProperty('--story-x', `${state.x}px`);
    storySection.style.setProperty('--story-y', `${state.y}px`);
    storySection.style.setProperty('--story-rotate', `${state.rotate}deg`);
    storySection.style.setProperty('--story-scale', state.scale);
    storyCaptions.forEach((caption, index) => {
      caption.classList.toggle('is-current', state.stage === index);
    });
    characterPoses.forEach((pose, index) => pose.classList.toggle('is-current', state.stage === index));
    characterScenes.forEach((scene, index) => scene.classList.toggle('is-current', state.stage === index));
  }
  scrollFrame = 0;
}
function queueProgress() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateProgress); }
addEventListener('scroll', queueProgress, { passive: true });
addEventListener('resize', queueProgress);
addEventListener('pageshow', queueProgress);
document.fonts.ready.then(queueProgress);
updateProgress();
document.querySelector('#year').textContent = new Date().getFullYear();

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WhaleMotion = require('../website/motion');

function element() {
  const attributes = {};
  const events = {};
  const properties = {};
  return {
    dataset: { theme: 'light' }, scrollHeight: 2000,
    attributes, events, properties,
    style: { setProperty: (key, value) => { properties[key] = value; } },
    classList: { remove() {}, toggle() {}, contains: () => false },
    setAttribute: (key, value) => { attributes[key] = value; },
    getAttribute: key => attributes[key],
    addEventListener: (name, callback) => { events[name] = callback; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
    offsetTop: 0, offsetHeight: 400,
  };
}

function page(reduced = false, fine = true) {
  const root = element();
  const nodes = new Map();
  const media = new Map();
  const context = {
    document: {
      documentElement: root,
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      addEventListener() {},
      querySelectorAll: () => [],
      fonts: { ready: { then() {} } },
    },
    localStorage: { getItem: () => null },
    matchMedia(query) {
      if (!media.has(query)) media.set(query, {
        matches: query.includes('reduced-motion') ? reduced : query.includes('pointer: fine') ? fine : false,
        addEventListener(name, handler) { this.change = handler; },
      });
      return media.get(query);
    },
    innerHeight: 800, scrollY: 600,
    WhaleMotion,
    addEventListener() {}, requestAnimationFrame() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../website/app.js'), 'utf8'), context);
  return { root, nodes, media };
}

const normal = page();
const toggle = normal.nodes.get('#motion-toggle');
assert.equal(normal.root.dataset.motion, 'running');
toggle.events.click();
assert.equal(normal.root.dataset.motion, 'paused');
assert.equal(toggle.attributes['aria-pressed'], 'true');
const art = normal.nodes.get('.hero-art');
art.events.pointermove({ clientX: 600, clientY: 400 });
assert.equal(art.properties['--tilt-x'], undefined, '暂停后不响应指针');
toggle.events.click();
art.events.pointermove({ clientX: 600, clientY: 400 });
assert.equal(art.properties['--tilt-x'], '5deg');
art.events.pointerleave();
assert.equal(art.properties['--tilt-x'], '0deg', '指针离开恢复中立位置');
assert.equal(normal.root.properties['--page-progress'], 0.5, '阅读进度按可滚动距离计算');

const reduced = page(true);
assert.equal(reduced.root.dataset.motion, 'paused', '系统减少动态效果优先');
assert.equal(reduced.nodes.get('#motion-toggle').disabled, true);
const preference = reduced.media.get('(prefers-reduced-motion: reduce)');
preference.matches = false;
preference.change({ matches: false });
assert.equal(reduced.root.dataset.motion, 'running', '实时跟随系统偏好变化');
assert.equal(reduced.nodes.get('#motion-toggle').disabled, false);

const touch = page(false, false);
touch.nodes.get('.hero-art').events.pointermove({ clientX: 600, clientY: 400 });
assert.equal(touch.nodes.get('.hero-art').properties['--tilt-x'], undefined, '触摸设备不启用倾斜');

const firstPass = WhaleMotion.reveal(750, 400, 800);
const inView = WhaleMotion.reveal(300, 400, 800);
assert.ok(firstPass.opacity < inView.opacity, '进入视口时逐步显现');
WhaleMotion.reveal(-500, 400, 800);
assert.deepEqual(WhaleMotion.reveal(750, 400, 800), firstPass, '看完后回滚仍沿同一轨迹重新过渡');
assert.equal(WhaleMotion.story(0, 2400, 800).stage, 0);
assert.equal(WhaleMotion.story(-800, 2400, 800).stage, 1);
assert.equal(WhaleMotion.story(-1600, 2400, 800).stage, 2);
assert.equal(WhaleMotion.story(-800, 2400, 800).stage, 1, '向上滚动能返回上一叙事阶段');
assert.equal(WhaleMotion.story(-4000, 2400, 800).progress, 1, '越过章节末尾不会外推变形');
assert.equal(WhaleMotion.story(800, 2400, 800).entrance, 0, '首页末尾保留过渡起点');
assert.equal(WhaleMotion.story(0, 2400, 800).entrance, 1, '角色进入驻留区域后完整显示');
assert.ok(WhaleMotion.story(350, 2400, 800).entrance > 0 && WhaleMotion.story(350, 2400, 800).entrance < 1, '两屏之间存在连续中间态');
assert.ok(Math.abs(WhaleMotion.story(-800, 2400, 800).rotate) <= 3, '角色微倾斜不会变成旋转贴纸');
console.log('website motion: pause, resume, system preference, pointer and reading progress passed');

'use strict';

/**
 * 本机所在地探测（services 层：可以联网、可以起子进程，但只在本机拼装）。
 *
 * 为什么要自己探：`config.env.location` 得人手动填，大部分人不会填；
 * 空着的时候，问「你在哪」她就只能瞎猜。
 *
 * 顺序（**先系统、后 IP**）：
 *   1. 系统定位：Windows 定位服务（WinRT `Windows.Devices.Geolocation`）。
 *      它走 Wi-Fi / GPS / 蜂窝基站，**不看公网 IP**，所以挂 VPN 也照样是本机位置。
 *   2. IP 兜底：系统定位被关掉、没有权限、拿不到时才用（`adapters/websearch` 的 ipCity）。
 *      这条会跟着出口 IP 走，挂 VPN 时可能显示成别的国家/城市 —— 所以文案里必须写明。
 *
 * 隐私（红线，改这里之前先看根目录 PRIVACY.md）：
 *   - 只留「市」一级（区县留给手填：实测定位落点会偏到隔壁区，说错区比只说市更糟）；
 *   - 街道门牌、镇、村、经纬度都不进提示词；
 *   - 定位结果只留内存，不落盘；日志只记来源和成功状态，不含地名、坐标或精度。
 *
 * 术语：`accuracy` 是系统给的误差半径（米）。50 公里意味着「就在这个圈里」，
 * 这时连区都点不准，所以括注里一直写「只到市」。
 */

const { execFile } = require('node:child_process');

// 只有显式要求带区、且精度好于这个值时才拼区（自动探测默认不带，见 composeLocation）
const FINE_ACCURACY_M = 3000;
// 结果缓存多久：位置不会天天变，但也不该永远钉住
const CACHE_MS = 30 * 60 * 1000;
// 同一个进程里两次探测至少隔这么久（防止清空手工地点后每条消息都去 spawn）
const MIN_PROBE_GAP_MS = 60 * 1000;
// 系统定位最多等多久（WinRT 在权限被拒时可能一直不返回）
const SYSTEM_TIMEOUT_MS = 15000;
const REVERSE_TIMEOUT_MS = 8000;

const WIN = process.platform === 'win32';

let cache = null;          // { text, source, accuracyM, at }
let lastProbeAt = 0;
let inflight = null;
let timer = null;
// 只有 app.js 启动时（startAutoProbe）才允许自动探测；
// 单元测试只直接调用纯函数 / 塞缓存，绝不能因为读一次环境块就去 spawn PowerShell。
let autoEnabled = false;

/* ------------------------------------------------------------------ */
/* 纯函数：地名拼装（单测直接打这几个）                                */
/* ------------------------------------------------------------------ */

/** 去掉空白和「省/市/区」以外的层级噪声，最后再过一遍区级截断 */
function tidy(name) {
  return String(name == null ? '' : name).replace(/[\r\n\t]/g, ' ').trim();
}

/**
 * 把行政区拼成「市」（**默认不拼区县**）。
 *
 * 为什么不拼区：实测定位点只到「市」这个量级就够用，而区县这一步经常是错的
 * —— Wi-Fi / 基站定位的落点会偏到隔壁区，逆地理接口再一换算，就成了「说错自己在哪个区」。
 * 说错区比只说市更糟，所以自动探测一律只到市；要精确到区，用 `env.location` 手填。
 *
 * @param {{province?:string, city?:string, district?:string}} admin
 * @param {number} accuracyM 系统给的误差半径（米），只影响括注，不改变粒度
 * @param {{allowDistrict?:boolean}} opts 只有显式传 true 才会带上区（手填路径 / 单测）
 */
function composeLocation(admin = {}, accuracyM = 0, { allowDistrict = false } = {}) {
  const a = admin && typeof admin === 'object' ? admin : {};
  const province = tidy(a.province);
  const city = tidy(a.city);
  const district = tidy(a.district);
  // 直辖市：省和市同名（北京市 / 北京市），只留一个
  const base = city || province;
  if (!base) return '';
  const sameCity = province && city && (city === province || province.startsWith(city) || city.startsWith(province));
  const head = sameCity ? city : base;
  if (!allowDistrict || !district) return head;
  const fine = Number(accuracyM) > 0 && Number(accuracyM) <= FINE_ACCURACY_M;
  if (!fine) return head;
  // 区已经是「某某市某某区」的一部分时别拼两遍
  if (head.includes(district)) return head;
  return head + district;
}

/** 精度说人话：米 → 公里 */
function formatAccuracy(accuracyM) {
  const m = Number(accuracyM) || 0;
  if (m <= 0) return '';
  if (m < 1000) return Math.round(m) + ' 米';
  return Math.round(m / 1000) + ' 公里';
}

/**
 * 这一行后面的括注。**「按出口 IP」必须写出来** —— 挂 VPN 时它可能是别的地方，
 * 不能让模型把出口地当成用户所在地。
 * 自动探测只到市，所以括注里一直带「只到市」：免得模型自己往下补到区。
 */
function noteFor(source, accuracyM) {
  if (source === 'system') {
    const acc = formatAccuracy(accuracyM);
    return acc ? `系统定位，精度约 ${acc}，只到市` : '系统定位，只到市';
  }
  if (source === 'ip') return '按网络出口 IP 推算，挂了 VPN 时可能不符';
  return '';
}

/* ------------------------------------------------------------------ */
/* 1) 系统定位（不经过公网 IP）                                        */
/* ------------------------------------------------------------------ */

// PS 5.1 才能直接投影 WinRT；pwsh 7 需要额外的 WinRT 模块，所以钉死系统自带那个
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const GEO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '[Windows.Devices.Geolocation.Geolocator,Windows.Devices.Geolocation,ContentType=WindowsRuntime] | Out-Null',
  '$m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
  '})[0]',
  '$g = $m.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition])',
  '$l = [Windows.Devices.Geolocation.Geolocator]::new()',
  '$l.DesiredAccuracy = [Windows.Devices.Geolocation.PositionAccuracy]::High',
  '$t = $g.Invoke($null, @($l.GetGeopositionAsync()))',
  "if (-not $t.Wait(9000)) { Write-Output 'TIMEOUT'; exit 2 }",
  '$p = $t.Result',
  '$c = $p.Coordinate.Point.Position',
  "Write-Output ('OK|{0}|{1}|{2}' -f $c.Latitude, $c.Longitude, $p.Coordinate.Accuracy)",
].join('\n');

/** Windows 定位服务 → { lat, lon, accuracyM }；拿不到返回 null */
function systemPosition({ timeoutMs = SYSTEM_TIMEOUT_MS } = {}) {
  if (!WIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      // -EncodedCommand：脚本只在命令行里传，不落临时文件（不留路径痕迹）
      const encoded = Buffer.from(GEO_SCRIPT, 'utf16le').toString('base64');
      execFile(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (err && !stdout) return finish(null);
          const m = String(stdout || '').match(/OK\|(-?[\d.]+)\|(-?[\d.]+)\|([\d.]+)/);
          if (!m) return finish(null);
          const lat = Number(m[1]);
          const lon = Number(m[2]);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return finish(null);
          finish({ lat, lon, accuracyM: Number(m[3]) || 0 });
        }
      );
    } catch {
      finish(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 2) 逆地理编码：坐标 → 省 / 市 / 区                                  */
/* ------------------------------------------------------------------ */

/**
 * 极简 JSON GET：带超时、跟最多 3 次重定向（BigDataCloud 会 307 到 api-bdc.io，
 * 不跟就会拿到空 body，逆地理编码直接失败）。
 */
function fetchJson(url, timeoutMs, hops = 3) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const mod = url.startsWith('https:') ? require('node:https') : require('node:http');
      const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'whale-gril/4.0' } }, (res) => {
        const status = Number(res.statusCode) || 0;
        if (status >= 300 && status < 400 && res.headers.location && hops > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          done = true; // 这一层不再 resolve，交给下一跳
          fetchJson(next, timeoutMs, hops - 1).then(resolve);
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return finish(null);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(null);
          }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/**
 * 坐标 → { province, city, district }。
 * 用 BigDataCloud 的公开逆地理接口：免 Key、支持 `localityLanguage=zh-Hans`（简体）。
 * 只发坐标，不带任何账号 / 会话信息。
 */
async function reverseGeocode(lat, lon, { timeoutMs = REVERSE_TIMEOUT_MS } = {}) {
  const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' +
    encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + '&localityLanguage=zh-Hans';
  const j = await fetchJson(url, timeoutMs);
  if (!j) return null;
  // administrative 里带 adminLevel：4=省、5=市、6=区县；没有就用顶层字段兜底
  const list = (j.localityInfo && Array.isArray(j.localityInfo.administrative)) ? j.localityInfo.administrative : [];
  const pick = (level) => {
    const hit = list.find((item) => Number(item.adminLevel) === level);
    return hit ? tidy(hit.name) : '';
  };
  const admin = {
    province: pick(4) || tidy(j.principalSubdivision),
    city: pick(5) || tidy(j.city),
    district: pick(6) || tidy(j.locality),
  };
  if (!admin.province && !admin.city) return null;
  return admin;
}

/* ------------------------------------------------------------------ */
/* 3) 整体流程 + 缓存                                                  */
/* ------------------------------------------------------------------ */

/** 完整探一次：系统定位优先，失败才退回出口 IP */
async function detect({ logger = null, ipFallback = true } = {}) {
  const pos = await systemPosition();
  if (pos) {
    const admin = await reverseGeocode(pos.lat, pos.lon);
    if (admin) {
      const text = composeLocation(admin, pos.accuracyM);
      if (text) {
        // DEBUG 同样会落盘，不能把提示词中的位置泄露到诊断日志。
        logger && logger.debug && logger.debug('[location] source=system result=available');
        return { text, source: 'system', accuracyM: pos.accuracyM, at: Date.now() };
      }
    }
  }
  if (ipFallback) {
    try {
      const websearch = require('../adapters/websearch');
      const city = tidy(await websearch.ipCity(REVERSE_TIMEOUT_MS));
      if (city) {
        // ipinfo 的城市名是英文（Xiamen），先换成中文（厦门）再进提示词
        let text = city;
        try {
          const place = await websearch.geocodeCity(city, REVERSE_TIMEOUT_MS);
          if (place && place.name) text = tidy(place.name);
        } catch { /* 换不出来就用原名 */ }
        if (text) {
          logger && logger.debug && logger.debug('[location] source=ip result=available');
          return { text, source: 'ip', accuracyM: 0, at: Date.now() };
        }
      }
    } catch { /* 拿不到就算了 */ }
  }
  return null;
}

/** 跑一次探测并写缓存（并发去重；失败保留上一次的结果） */
function refresh({ logger = null, force = false } = {}) {
  if (inflight) return inflight;
  const now = Date.now();
  if (!force && now - lastProbeAt < MIN_PROBE_GAP_MS) return Promise.resolve(cache);
  lastProbeAt = now;
  inflight = detect({ logger })
    .then((hit) => {
      if (hit) cache = hit;
      return cache;
    })
    .catch(() => cache)
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * 启动时开一次后台探测，之后定期刷新。
 * 关掉 features.envContext 或 `env.autoDetect=false` 就完全不动（不起子进程、不联网）。
 */
function startAutoProbe(config, { logger = null, intervalMs = CACHE_MS } = {}) {
  let features;
  try {
    features = require('../infra/features');
  } catch {
    return () => {};
  }
  const enabled = () => features.isOn(config, 'envContext') && (!config.env || config.env.autoDetect !== false);
  if (!enabled()) return () => {};
  autoEnabled = true;

  const tick = () => {
    if (!enabled()) return;
    // 手工填了地点就不用探了；清掉之后下一次 tick / 需要时再探
    const manual = String((config.env && config.env.location) || '').trim();
    if (manual) return;
    refresh({ logger });
  };
  tick();
  try {
    timer = setInterval(tick, Math.max(60000, Number(intervalMs) || CACHE_MS));
    if (timer.unref) timer.unref();
  } catch { /* 定时器起不来也不影响首次探测 */ }
  return stop;
}

function stop() {
  autoEnabled = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 同步读缓存（systemBlock 用；没有就是 null） */
function cached() {
  if (!cache) return null;
  if (Date.now() - cache.at > CACHE_MS * 4) return cache; // 过期也别当场清空，等下一次刷新
  return cache;
}

/** 需要时补一次探测（不阻塞调用方）：清掉手工地点后能较快恢复 */
function ensureProbe(options = {}) {
  if (!autoEnabled) return; // 没走 startAutoProbe（测试 / 单测）就不许起子进程
  if (cache && Date.now() - cache.at < CACHE_MS) return;
  refresh(options);
}

// 测试用：不联网、不起子进程，直接塞一个结果进去
function _setCacheForTest(value) {
  cache = value ? { at: Date.now(), accuracyM: 0, ...value } : null;
}

function _clearForTest() {
  cache = null;
  lastProbeAt = 0;
  inflight = null;
  stop();
}

module.exports = {
  detect,
  refresh,
  startAutoProbe,
  stop,
  cached,
  ensureProbe,
  systemPosition,
  reverseGeocode,
  composeLocation,
  noteFor,
  formatAccuracy,
  FINE_ACCURACY_M,
  _setCacheForTest,
  _clearForTest,
};

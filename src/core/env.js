'use strict';

/**
 * 机器环境快照（core 层：只用 node 内置模块，不读配置、不联网、不落盘）。
 *
 * 为什么单独抽一层：提示词里要能说出「你用的什么系统 / 你那边几点了 / 你电脑卡不卡」，
 * 以前模型只能按训练数据瞎猜（问系统就答「我不太清楚」或者干脆编）。
 * 这类信息是**稳定**的（进程活着的这段时间不会变），所以只采一次、进程内缓存，
 * 拼出来的 <env> 块才能逐字节稳定，不打断前缀缓存。
 *
 * 隐私红线（这里就是执行点）：
 *   - 只取系统名 / 版本 / 架构 / 核数 / 内存 / 时区 / node 版本这几项；
 *   - **不取**主机名、用户名、家目录、安装路径、IP、地理位置；
 *   - 具体地址（精确到区）由上层按配置拼，不在这里读。
 *
 * 为什么不用 `reg query` 拿「家庭中文版 / 23H2」：
 *   node 的 `os.version()` 在 Windows 上本来就返回产品名（如 `Windows 11 Home China`），
 *   而每一次子进程调用都要开管道、几百毫秒，还会被各种运行环境限制；
 *   core 层保持「零子进程」，需要更细的版本就直接查表。
 */
const os = require('node:os');

/**
 * Windows 内部版本号 → 对外版本号（22H2 / 23H2 / 24H2 …）。
 * 只列到目前真实发布过的；查不到就不写，绝不猜。
 */
const WINDOWS_RELEASE = {
  19041: '2004',
  19042: '20H2',
  19043: '21H1',
  19044: '21H2',
  19045: '22H2',
  22000: '21H2',
  22621: '22H2',
  22631: '23H2',
  26100: '24H2',
  26200: '25H2',
  20348: 'Server 2022',
  17763: 'Server 2019',
};

/**
 * `os.version()` 在英文系统上给的是英文产品名，中文系统上本来就是中文。
 * 这里只把常见的英文版次换成中文，查不到就原样保留（不硬翻、不编）。
 */
const EDITION_WORDS = [
  ['Home China', '家庭中文版'],
  ['Home Single Language', '家庭单语言版'],
  ['Home', '家庭版'],
  ['Pro for Workstations', '专业工作站版'],
  ['Pro Education', '专业教育版'],
  ['Pro', '专业版'],
  ['Enterprise', '企业版'],
  ['Education', '教育版'],
  ['IoT', 'IoT'],
  ['Server Standard', 'Server 标准版'],
  ['Server Datacenter', 'Server 数据中心版'],
];

let cached = null;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** 英文版次 → 中文；已经带中文或匹配不上就原样返回 */
function localizeEdition(product) {
  let text = String(product || '');
  if (!text) return '';
  // 已经是中文（含 CJK）就不用再翻
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  for (const [en, zh] of EDITION_WORDS) {
    // 只按整词替换，别把 Enterprise 改成「企业版…」
    const re = new RegExp('(^|\\s)' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'g');
    text = text.replace(re, (all, lead) => lead + zh);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** 系统名 + 对外版本号，两段分开给 formatBlock 拼 */
function describeOs() {
  const platform = os.platform();
  const release = String(os.release() || '');
  if (platform === 'win32') {
    const build = Number(String(release).split('.')[2]) || 0;
    const product = localizeEdition(nonEmpty(os.version())) || 'Windows';
    const label = WINDOWS_RELEASE[build] || '';
    // 例：Windows 11 家庭中文版 + 25H2 (26200)
    const version = label ? `${label} (${build})` : build ? String(build) : release;
    return { osName: product, osVersion: version };
  }
  if (platform === 'darwin') {
    // macOS 的版本号是内核版本，硬映射成 14 / 15 这种是猜；只给内核版本
    return { osName: 'macOS', osVersion: release };
  }
  if (platform === 'linux') {
    const distro = nonEmpty(os.version());
    return { osName: distro && !/^(Linux|#)/i.test(distro) ? distro : 'Linux', osVersion: release };
  }
  return { osName: nonEmpty(os.type()) || platform || '未知系统', osVersion: release };
}

/**
 * 采一次机器信息并缓存。
 * 字段固定就这 7 个：**没有时间类字段**（时间每轮都在变，属于「此刻」，不该进静态环境块）。
 * 返回对象冻结，避免调用方顺手改掉进程内唯一的那份。
 * @returns {{osName:string, osVersion:string, arch:string, cpuCores:number, memGB:number, tz:string, node:string}}
 */
function snapshot() {
  if (cached) return cached;
  const { osName, osVersion } = describeOs();
  const totalMem = Number(os.totalmem()) || 0;
  let cpus = 0;
  try {
    cpus = os.cpus().length;
  } catch { /* 极少数受限环境拿不到，就不写核数 */ }
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch { /* 拿不到时区就不写这一行 */ }
  cached = Object.freeze({
    osName,
    osVersion,
    arch: String(os.arch() || ''),
    cpuCores: cpus,
    // 取整到 GB：给模型看的是「卡不卡」的量级，不需要精确到小数点
    memGB: totalMem ? Math.round(totalMem / (1024 ** 3)) : 0,
    tz,
    node: String(process.version || ''),
  });
  return cached;
}

/**
 * 时区偏移标签：Asia/Shanghai → UTC+8。
 * 用 Intl 的 shortOffset 而不是硬编码 +8：夏令时地区和半小时时区也能对。
 */
function tzOffsetLabel(tz) {
  if (!tz) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date());
    const name = String((parts.find((p) => p.type === 'timeZoneName') || {}).value || '');
    if (!name) return '';
    const label = name.replace(/^GMT/i, 'UTC');
    // GMT+0 / UTC+0 这种没信息量的就别写成 (UTC+0) 了
    return /^UTC[+-]0$/.test(label) ? 'UTC' : label;
  } catch {
    return '';
  }
}

/**
 * 拼成 <env> 文本块。
 * @param {object} snap snapshot() 的结果（允许传自定义对象，测试用）
 * @param {{location?:string, locationNote?:string, version?:string}} opts
 *   location 为空就整行不写；locationNote 是括注（「系统定位，精度约 50 公里」这类），
 *   由上层决定写什么 —— 这一层不认识「怎么探来的」，只负责排版。
 */
function formatBlock(snap, { location = '', locationNote = '', version = '' } = {}) {
  const s = snap && typeof snap === 'object' ? snap : snapshot();
  const place = nonEmpty(location);
  const note = nonEmpty(locationNote);
  const ver = nonEmpty(version);
  const lines = ['<env>'];
  if (place) lines.push('所在地：' + place + (note ? '（' + note + '）' : ''));
  const system = [nonEmpty(s.osName), nonEmpty(s.osVersion)].filter(Boolean).join(' ');
  if (system) lines.push('系统：' + system);
  const hardware = [];
  if (nonEmpty(s.arch)) hardware.push(String(s.arch));
  if (Number(s.cpuCores) > 0) hardware.push('CPU ' + Number(s.cpuCores) + ' 核');
  if (Number(s.memGB) > 0) hardware.push('内存 ' + Number(s.memGB) + ' GB');
  if (hardware.length) lines.push('架构：' + hardware.join(' · '));
  if (nonEmpty(s.tz)) {
    const offset = tzOffsetLabel(s.tz);
    lines.push('时区：' + s.tz + (offset ? ' (' + offset + ')' : ''));
  }
  const runtime = [];
  if (nonEmpty(s.node)) runtime.push('Node：' + s.node);
  if (ver) runtime.push('程序版本 ' + ver);
  if (runtime.length) lines.push(runtime.join(' · '));
  lines.push('</env>');
  return lines.join('\n');
}

module.exports = { snapshot, formatBlock, tzOffsetLabel, localizeEdition, WINDOWS_RELEASE };

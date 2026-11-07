'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 隔离系统/网络输入，执行真实 detect；不探测测试机位置、不写运行数据。
for (const source of ['system', 'ip']) {
  test(`定位 ${source} 路线只在内存返回位置，日志不含位置或精度`, async () => {
    const logs = [];
    const context = {
      module: { exports: {} }, process: { platform: 'test' },
      require: id => id === '../adapters/websearch'
        ? { ipCity: async () => 'PrivateCity', geocodeCity: async () => ({ name: '测试隐私城市' }) }
        : require(id),
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/services/location.js'), 'utf8') + `
      systemPosition = async () => (${source === 'system' ? '{lat:12.345,lon:67.89,accuracyM:1234}' : 'null'});
      reverseGeocode = async () => ({city:'测试隐私城市'});
      module.exports.testDetect = detect;
    `, context);
    const result = await context.module.exports.testDetect({ logger: { debug: line => logs.push(line) } });
    assert.equal(result.text, '测试隐私城市');
    assert.equal(result.source, source);
    assert.deepEqual(logs, [`[location] source=${source} result=available`]);
    assert.doesNotMatch(logs.join(''), /测试隐私城市|PrivateCity|12\.345|67\.89|1234|所在地：|<env>/);
  });
}

'use strict';

// 桥接已拆成 app.py + mixin；源码级回归测试不再假设某个函数一定在 engine.py。
// 这里把所有 bridge/*.py 拼起来，供“必须有这段代码/文案”的断言使用。
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '..', 'bridge');
module.exports = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.py'))
  .sort()
  .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
  .join('\n\n')
  // 源码级回归测试是按拆分前的 engine.py 写的；这里去掉运行时前缀，
  // 让「必须存在这段逻辑」的断言继续盯实现本身，而不是盯 self./G. 写法。
  .replace(/\bself\./g, '')
  .replace(/\bG\./g, '')
  // mixin 方法签名是 def x(self, ...)，旧断言按 def x(...) 写的。
  .replace(/def (\w+)\(self\):/g, 'def $1():')
  .replace(/def (\w+)\(self,\s*/g, 'def $1(');

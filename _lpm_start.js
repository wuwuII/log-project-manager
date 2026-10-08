// ============================================================
//  日志与项目管理 —— 无窗口启动器
//  由同文件夹的「启动.bat」(Windows) 调用：node "_lpm_start.js"
//
//  · 用 Node 自带的 detached + windowsHide 把服务拉起来 ⇒ 服务本身没有窗口
//  · 已经在运行就不重复启动，只把页面打开
//  · 关掉网页 90 秒无心跳 ⇒ 自动落盘退出（页面上每 10 秒报一次心跳）
//  · 不写注册表、不建计划任务、不开机自启
//  · 一切路径都从「本文件所在文件夹」推出来 ⇒ 整个文件夹复制到别处照样能用
//  · 日志写到系统临时目录的 lpm_app.log
//
//  Node 运行时怎么找（2026-10-06 改为两级查找，为开源版做准备）：
//     ① 先找同文件夹下的便携运行时：node\node.exe (Windows) / node\node (Linux·macOS)
//        —— 离线包就是这条路（整包拷走即用，不用装 Node）
//     ② 找不到就用「正在跑本脚本的这个 node」（= 系统装的 Node）
//        —— 从源码跑就是这条路
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const IS_WIN = process.platform === 'win32';

const root = __dirname;                                   // 本文件所在文件夹
const backend = path.join(root, 'backend');
const PORT = process.env.LPM_PORT || '5174';
const logFile = path.join(os.tmpdir(), 'lpm_app.log');

/** 便携运行时优先，找不到就用当前这个 node（系统装的） */
function resolveNode() {
  const portable = IS_WIN
    ? path.join(root, 'node', 'node.exe')
    : path.join(root, 'node', 'node');
  return fs.existsSync(portable) ? portable : process.execPath;
}

const nodeExe = resolveNode();

if (!fs.existsSync(path.join(backend, 'dist', 'app.js'))) {
  console.error('[LPM] 找不到后端构建产物：' + path.join(backend, 'dist', 'app.js'));
  console.error('[LPM] 请先构建（见 README「从源码运行」）：');
  console.error('[LPM]   cd backend  && npm install && npm run build');
  console.error('[LPM]   cd frontend && npm install && npm run build');
  process.exit(1);
}

function isUp(cb) {
  const s = net.connect(Number(PORT), '127.0.0.1');
  let done = false;
  const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} cb(v); } };
  s.on('connect', () => fin(true));
  s.on('error', () => fin(false));
  s.setTimeout(800, () => fin(false));
}

/** 用系统默认浏览器打开页面 */
function openBrowser() {
  const url = 'http://localhost:' + PORT + '/?t=' + Date.now();
  const opts = { windowsHide: true, detached: true, stdio: 'ignore' };
  try {
    if (IS_WIN) {
      // Windows：优先 Edge，失败再退回系统默认浏览器
      try {
        spawn('cmd', ['/c', 'start', '', 'msedge.exe', url], opts).unref();
      } catch (e) {
        spawn('cmd', ['/c', 'start', '', url], opts).unref();
      }
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref();
    } else {
      const p = spawn('xdg-open', [url], opts);
      p.on('error', () => {});
      p.unref();
    }
  } catch (e) { /* 打不开浏览器不致命：手动访问 http://localhost:<port> 即可 */ }
}

isUp((up) => {
  if (up) { openBrowser(); return; }          // 已经在跑：只开页面

  let out = 'ignore';
  try { out = fs.openSync(logFile, 'a'); } catch (e) {}

  const child = spawn(nodeExe, ['dist/app.js'], {
    cwd: backend,
    detached: true,        // 脱离父进程，父进程退出它继续跑
    windowsHide: true,     // ← 关键：服务完全没有窗口
    stdio: out === 'ignore' ? 'ignore' : ['ignore', out, out],
    env: Object.assign({}, process.env, { PORT: String(PORT), LPM_WATCHDOG: '1' }),
  });
  child.unref();

  let tries = 0;
  const timer = setInterval(() => {
    isUp((ok) => {
      tries += 1;
      if (ok || tries > 30) {
        clearInterval(timer);
        openBrowser();
        process.exit(0);
      }
    });
  }, 300);
});

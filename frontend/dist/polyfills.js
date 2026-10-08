/* ══════════════════════════════════════════════════════════════════════
 * polyfills.js —— 为老旧浏览器补上缺失的 API
 *
 * 🔴 为什么必须放这个文件（2026-10-03 用户机器上实测崩溃）：
 *    用户那台不联网的 Windows 上 Edge 从未更新过，缺少 ES2023 的
 *    Array.prototype.toSorted / toReversed / toSpliced / with 等新方法。
 *    甘特图（SVAR）内部调用了 `.map(...).toSorted(...)`，
 *    一打开「项目计划」工作表就抛
 *        TypeError: l.map(...).toSorted is not a function
 *    页面随之崩溃，且刷新也回不来。
 *
 *    这个文件是「普通脚本」（不是 module），在 <head> 里排在打包脚本之前，
 *    保证在应用代码执行前就已经补齐。所有补丁都先判断是否存在，
 *    新浏览器上完全不做任何事。
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var def = function (obj, name, value, enumerable) {
    if (!obj || typeof obj[name] !== 'undefined') return;
    try {
      Object.defineProperty(obj, name, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: !!enumerable,
      });
    } catch (e) {
      /* 兜底：直接赋值 */
      try { obj[name] = value; } catch (e2) {}
    }
  };

  var A = Array.prototype;

  /* ── ES2022: Array.prototype.at ───────────────────────────────── */
  def(A, 'at', function at(i) {
    var n = Math.trunc(Number(i)) || 0;
    return n < 0 ? this[this.length + n] : this[n];
  });

  /* ── ES2023: toReversed / toSorted / toSpliced / with ─────────── */
  def(A, 'toReversed', function toReversed() {
    return this.slice().reverse();
  });
  def(A, 'toSorted', function toSorted(cmp) {
    return this.slice().sort(cmp);
  });
  def(A, 'toSpliced', function toSpliced(start, deleteCount) {
    var copy = this.slice();
    var args = [start, deleteCount].concat(
      Array.prototype.slice.call(arguments, 2)
    );
    if (arguments.length === 1) args = [start];
    if (arguments.length === 0) args = [];
    return copy.splice.apply(copy, args);
  });
  def(A, 'with', function withAt(i, value) {
    var n = Math.trunc(Number(i)) || 0;
    if (n < 0) n = this.length + n;
    if (n < 0 || n >= this.length) throw new RangeError('Invalid index');
    var copy = this.slice();
    copy[n] = value;
    return copy;
  });

  /* ── ES2022: findLast / findLastIndex ────────────────────────── */
  def(A, 'findLast', function findLast(fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (fn.call(thisArg, this[i], i, this)) return this[i];
    }
    return undefined;
  });
  def(A, 'findLastIndex', function findLastIndex(fn, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (fn.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  });

  /* ── ES2019: flat / flatMap ──────────────────────────────────── */
  def(A, 'flat', function flat(depth) {
    var d = typeof depth === 'undefined' ? 1 : Number(depth) || 0;
    var out = [];
    (function walk(arr, level) {
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (Array.isArray(v) && level > 0) walk(v, level - 1);
        else out.push(v);
      }
    })(this, d);
    return out;
  });
  def(A, 'flatMap', function flatMap(fn, thisArg) {
    return A.flat.call(
      A.map.call(this, fn, thisArg),
      1
    );
  });

  /* ── ES2022: Object.hasOwn ───────────────────────────────────── */
  def(Object, 'hasOwn', function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  });
  /* ── ES2019: Object.fromEntries ──────────────────────────────── */
  def(Object, 'fromEntries', function fromEntries(iter) {
    var o = {};
    if (!iter) return o;
    if (typeof iter[Symbol.iterator] === 'function') {
      for (var pair of iter) o[pair[0]] = pair[1];
      return o;
    }
    Object.keys(iter).forEach(function (k) { o[k] = iter[k]; });
    return o;
  });

  /* ── ES2021: String.replaceAll / String.at ───────────────────── */
  def(String.prototype, 'replaceAll', function replaceAll(find, rep) {
    var s = find;
    if (s instanceof RegExp) {
      var flags = s.flags.indexOf('g') === -1 ? s.flags + 'g' : s.flags;
      return this.replace(new RegExp(s.source, flags), rep);
    }
    var out = this;
    var idx = out.indexOf(s);
    while (idx !== -1) {
      out = out.slice(0, idx) + rep + out.slice(idx + String(s).length);
      idx = out.indexOf(s, idx + String(rep).length);
    }
    return out;
  });
  def(String.prototype, 'at', function at(i) {
    var n = Math.trunc(Number(i)) || 0;
    return n < 0 ? this[this.length + n] : this[n];
  });

  /* ── globalThis / Promise 补充 ───────────────────────────────── */
  if (typeof globalThis === 'undefined') {
    try { window.globalThis = window; } catch (e) {}
  }
  if (typeof Promise !== 'undefined') {
    if (!Promise.allSettled) {
      Promise.allSettled = function (list) {
        return Promise.all(
          (list || []).map(function (p) {
            return Promise.resolve(p).then(
              function (v) { return { status: 'fulfilled', value: v }; },
              function (e) { return { status: 'rejected', reason: e }; }
            );
          })
        );
      };
    }
    if (!Promise.any) {
      Promise.any = function (list) {
        return new Promise(function (resolve, reject) {
          var errs = [], pending = (list || []).length;
          if (!pending) return reject(new Error('All promises were rejected'));
          list.forEach(function (p, i) {
            Promise.resolve(p).then(resolve, function (e) {
              errs[i] = e;
              if (--pending === 0) reject(new Error('All promises were rejected'));
            });
          });
        });
      };
    }
  }

  /* ── structuredClone（老 Edge 没有）───────────────────────────── */
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = function (v) {
      try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
    };
  }

  /* ── requestIdleCallback / queueMicrotask 兜底 ───────────────── */
  if (typeof window.requestIdleCallback !== 'function') {
    window.requestIdleCallback = function (cb) {
      return setTimeout(function () {
        cb({ didTimeout: false, timeRemaining: function () { return 50; } });
      }, 1);
    };
    window.cancelIdleCallback = function (id) { clearTimeout(id); };
  }
  if (typeof window.queueMicrotask !== 'function') {
    window.queueMicrotask = function (cb) {
      Promise.resolve().then(cb);
    };
  }

  /* ── ES2022: Element.replaceChildren（部分老内核缺）───────────── */
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) this.appendChild(arguments[i]);
    };
  }
})();

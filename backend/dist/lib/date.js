"use strict";
/**
 * 日期工具 —— 统一本地日期格式化
 *
 * 🔴 禁止用 `new Date().toISOString().slice(0,10)` 取「今天」：
 *    toISOString() 转 UTC，东八区凌晨 0:00~8:00 会返回**前一天**。
 *    项目里所有 YYYY-MM-DD 一律走这里。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ymd = ymd;
exports.todayStr = todayStr;
exports.addDays = addDays;
const pad = (n) => String(n).padStart(2, '0');
/** Date → 'YYYY-MM-DD'（本地时区） */
function ymd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 今天 'YYYY-MM-DD'（本地时区） */
function todayStr() {
    return ymd(new Date());
}
/** 在 'YYYY-MM-DD' 上加 n 天，返回 'YYYY-MM-DD' */
function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime()))
        return null;
    d.setDate(d.getDate() + n);
    return ymd(d);
}

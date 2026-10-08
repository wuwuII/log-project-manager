"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calcTaskEarned = calcTaskEarned;
exports.deriveTaskStatus = deriveTaskStatus;
exports.calcPlanEnd = calcPlanEnd;
// 积分计算（方案附录 A）
// 规则：
//   - 待办完成 → 获得待办设置的积分
//   - 项目任务 → 总积分 × 完成百分比
//   - 支持阶梯积分：每 10% 触发一次（即只有满 10% 的整数倍才计分）
//   - 所有变动都写 points_ledger 流水
const date_1 = require("./date");
/** 计算项目任务当前应得积分 */
function calcTaskEarned(totalPoints, progress, stepped = false) {
    const p = Math.max(0, Math.min(100, Math.round(progress || 0)));
    const effective = stepped ? Math.floor(p / 10) * 10 : p;
    return Math.round(totalPoints * (effective / 100) * 100) / 100;
}
/** 任务状态推导 */
function deriveTaskStatus(progress, planEnd) {
    const today = (0, date_1.todayStr)();
    if ((progress || 0) >= 100)
        return 'done';
    if (planEnd && planEnd < today && (progress || 0) < 100)
        return 'delayed';
    return (progress || 0) > 0 ? 'in_progress' : 'not_started';
}
/** 计划结束日（plan_start + plan_duration - 1 天）—— 本地时区，勿用 toISOString */
function calcPlanEnd(planStart, duration) {
    if (!planStart)
        return null;
    return (0, date_1.addDays)(planStart, Math.max(0, (duration || 1) - 1));
}

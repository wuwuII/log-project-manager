// 积分计算（方案附录 A）
// 规则：
//   - 待办完成 → 获得待办设置的积分
//   - 项目任务 → 总积分 × 完成百分比
//   - 支持阶梯积分：每 10% 触发一次（即只有满 10% 的整数倍才计分）
//   - 所有变动都写 points_ledger 流水
import { addDays, todayStr } from './date';

/** 计算项目任务当前应得积分 */
export function calcTaskEarned(totalPoints: number, progress: number, stepped = false): number {
  const p = Math.max(0, Math.min(100, Math.round(progress || 0)));
  const effective = stepped ? Math.floor(p / 10) * 10 : p;
  return Math.round(totalPoints * (effective / 100) * 100) / 100;
}

/** 任务状态推导 */
export function deriveTaskStatus(progress: number, planEnd?: string | null): string {
  const today = todayStr();
  if ((progress || 0) >= 100) return 'done';
  if (planEnd && planEnd < today && (progress || 0) < 100) return 'delayed';
  return (progress || 0) > 0 ? 'in_progress' : 'not_started';
}

/** 计划结束日（plan_start + plan_duration - 1 天）—— 本地时区，勿用 toISOString */
export function calcPlanEnd(planStart?: string | null, duration?: number | null): string | null {
  if (!planStart) return null;
  return addDays(planStart, Math.max(0, (duration || 1) - 1));
}

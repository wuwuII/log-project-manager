"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logChange = logChange;
exports.addPoints = addPoints;
exports.recalcPersonPoints = recalcPersonPoints;
const prisma_1 = __importDefault(require("./prisma"));
/**
 * 写操作历史。历史记录失败绝不影响主流程 —— 全部 try/catch 吞掉。
 */
async function logChange(opts) {
    try {
        await prisma_1.default.changeHistory.create({
            data: {
                table_id: opts.table_id ?? null,
                record_id: opts.record_id ?? null,
                entity: opts.entity ?? null,
                action: opts.action,
                before: opts.before === undefined ? null : JSON.stringify(opts.before),
                after: opts.after === undefined ? null : JSON.stringify(opts.after),
                changed_by: opts.changed_by ?? null,
            },
        });
    }
    catch (e) {
        console.error('[history] 写历史失败（已忽略）:', e);
    }
}
/**
 * 记积分流水，并同步更新 people.total_points 缓存。
 * delta 为本次变动值（可为负）。
 */
async function addPoints(opts) {
    const person = await prisma_1.default.person.findUnique({ where: { id: opts.person_id } });
    if (!person)
        return;
    await prisma_1.default.pointsLedger.create({
        data: {
            person_id: opts.person_id,
            person_name: person.name,
            source_type: opts.source_type,
            source_id: opts.source_id ?? null,
            points: opts.points,
            reason: opts.reason ?? null,
        },
    });
    await prisma_1.default.person.update({
        where: { id: opts.person_id },
        data: { total_points: (person.total_points || 0) + opts.points },
    });
}
/**
 * 重算某人的积分缓存（把流水求和覆盖 total_points）。
 * 用于纠错 —— 流水是唯一真相，缓存可随时重建。
 */
async function recalcPersonPoints(person_id) {
    const agg = await prisma_1.default.pointsLedger.aggregate({
        where: { person_id },
        _sum: { points: true },
    });
    const total = Math.round((agg._sum.points || 0) * 100) / 100;
    await prisma_1.default.person.update({ where: { id: person_id }, data: { total_points: total } });
    return total;
}

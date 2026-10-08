export type TableType = 'log' | 'project' | 'people';

export interface TableMeta {
  id: string;
  name: string;
  type: TableType;
  config: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface LogEntry {
  id: string;
  table_id: string;
  entry_date: string;
  content: string;
  updated_at: string;
}

export interface Todo {
  id: string;
  table_id: string;
  title: string;
  assignee_id?: string | null;
  points: number;
  status: 'pending' | 'done';
  record_time: string;
  completed_at?: string | null;
  sort_order: number;
  linked_project_id?: string | null;
  linked_task_id?: string | null;
  transferred: boolean;
  note?: string | null;
}

export interface Person {
  id: string;
  name: string;
  role?: string | null;
  color?: string | null;
  total_points: number;
}

export interface Project {
  id: string;
  table_id: string;
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  status: string;
}

export interface ProjectTask {
  id: string;
  project_id: string;
  parent_id?: string | null;
  name: string;
  plan_start?: string | null;
  plan_duration: number;
  plan_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  progress: number;
  assignee_id?: string | null;
  points: number;
  earned_points: number;
  status: string;
  sort_order: number;
  note?: string | null;
}

export interface PointsSummaryItem {
  person_id: string;
  name: string;
  role?: string | null;
  color?: string | null;
  total_points: number;
  range_points: number;
}

/** 回收站行（与后端 /api/recycle/list 字段对齐） */
export interface RecycleRow {
  id: string;
  name: string;
  deleted_at?: string | null;
  parent_id?: string | null;
  parent_name?: string | null;
  parent_deleted?: boolean;
}

/** 提醒重复方式：只此一次 / 每周 / 每月 / 每年 */
export type ReminderRepeat = 'once' | 'weekly' | 'monthly' | 'yearly';

/**
 * 提醒（2026-10-08 新增）—— 日志页格子里「提前写好的文字」
 * rule 由后端解析成对象：
 *   once    { date: 'YYYY-MM-DD' }
 *   weekly  { weekdays: number[] }  1=周一 … 7=周日
 *   monthly { days: number[] }      每月几号
 *   yearly  { dates: { month: number; day: number }[] }
 */
export interface Reminder {
  id: string;
  table_id: string;
  text: string;
  repeat: ReminderRepeat;
  rule: any;
  start_date?: string | null;
  end_date?: string | null;
  enabled: boolean;
  color?: string | null;
  sort_order: number;
}

/** 展开到某一天的提醒（日志格子用） */
export interface ReminderHit {
  id: string;
  text: string;
  color?: string | null;
  repeat: ReminderRepeat;
}

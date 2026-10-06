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

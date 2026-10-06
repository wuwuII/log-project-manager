import React, { createContext, useContext } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * 拖动排序通用件
 *
 * 关键点：PointerSensor 设 distance:6 —— 鼠标按下后移动超过 6px 才算拖拽，
 * 这样「点击按钮」和「拖动行」不会互相干扰（否则点删除键会误触发拖动）。
 *
 * 🔴 2026-10-03 改动（用户反馈：拖进度条和拖任务行抢手势）：
 *   原来 listeners 挂在整行 <tr> 上 → 行内任何地方按下都能拖行，
 *   与行内的「进度滑块」「按钮」抢同一个鼠标手势，经常误拖。
 *   → 现在 listeners 只挂在**行首的拖动把手**（<DragHandle/>）上，
 *     行其余部分（滑块/按钮/输入框）完全不受影响。
 */
export function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** 把一次拖拽结束事件换算成新的 id 顺序 */
export function reorderIds(ids: string[], e: DragEndEvent): string[] | null {
  const { active, over } = e;
  if (!over || active.id === over.id) return null;
  const oldIndex = ids.indexOf(String(active.id));
  const newIndex = ids.indexOf(String(over.id));
  if (oldIndex < 0 || newIndex < 0) return null;
  return arrayMove(ids, oldIndex, newIndex);
}

type HandleCtx = { attributes: any; listeners: any; disabled: boolean } | null;

/** 行内把手通过它拿到拖拽监听器（只有把手能拖） */
const DragHandleContext = createContext<HandleCtx>(null);

/**
 * 行首拖动把手。放进 Table 的某一列里即可。
 * 只有它带着 dnd 的 listeners，所以拖它=排序，点别处=正常操作。
 */
export const DragHandle: React.FC<{ title?: string }> = ({ title = '按住拖动排序' }) => {
  const ctx = useContext(DragHandleContext);
  if (!ctx) return null;
  return (
    <span
      title={title}
      {...ctx.attributes}
      {...ctx.listeners}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        color: '#bbb',
        cursor: 'grab',
        fontSize: 12,
        lineHeight: 1,
        userSelect: 'none',
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#666')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#bbb')}
    >
      ⠿
    </span>
  );
};

/** antd Table 的可拖动行：只负责位移，监听器交给 DragHandle
 *  ⚠️ 必须排除没有 data-row-key 的行（antd 的测量行/表头行）。
 */
export const SortableRow: React.FC<any> = (props) => {
  const id = props['data-row-key'];
  const isRealRow = id !== undefined && id !== null && String(id) !== '';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(id ?? ''),
    disabled: !isRealRow,
  });
  const style: React.CSSProperties = {
    ...props.style,
    ...(isRealRow
      ? {
          transform: CSS.Translate.toString(transform),
          transition,
          ...(isDragging ? { position: 'relative', zIndex: 9, background: '#eef7f1' } : {}),
        }
      : {}),
  };
  if (!isRealRow) {
    return <tr {...props} style={style} />;
  }
  return (
    <DragHandleContext.Provider value={{ attributes, listeners, disabled: !isRealRow }}>
      <tr {...props} ref={setNodeRef} style={style}>
        {props.children}
      </tr>
    </DragHandleContext.Provider>
  );
};

/** antd Table 拖拽包裹器 */
export const SortableTableBody: React.FC<{
  items: string[];
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (e: DragEndEvent) => void;
  children: React.ReactNode;
}> = ({ items, sensors, onDragEnd, children }) => (
  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  </DndContext>
);

/** 普通列表项（待办栏用）—— 整项可拖，因为待办项里没有滑块/输入框 */
export const SortableItem: React.FC<{ id: string; className?: string; children: React.ReactNode }> = ({
  id,
  className,
  children,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(id),
  });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    cursor: 'grab',
    position: 'relative',
    zIndex: isDragging ? 9 : undefined,
    background: isDragging ? '#eef7f1' : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className={className} {...attributes} {...listeners}>
      {children}
    </div>
  );
};

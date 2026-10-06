import React from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { DndContext, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import type { TableMeta } from '../types';
import { SortableItem, reorderIds, useDragSensors } from '../utils/dragSort';

const TYPE_LABEL: Record<string, string> = { log: '日志', project: '项目', people: '人员' };

interface Props {
  tables: TableMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (t: TableMeta) => void;
  onDuplicate: (t: TableMeta) => void;
  onDelete: (t: TableMeta) => void;
  onExportOne: (t: TableMeta) => void;
  /** 拖动 / 「左移·右移」后回传新的 id 顺序（松手或点击即保存） */
  onReorder: (orderedIds: string[]) => void;
}

/**
 * 永久工作表标签栏 —— 常驻、不可关闭。
 *
 * 🔴 2026-10-06 新增：标签可拖动排序 + 右键菜单「左移 / 右移」。
 *   · 拖动：复用 utils/dragSort.tsx 的 useDragSensors / reorderIds / SortableItem，
 *     容器策略用 horizontalListSortingStrategy（标签栏是横向的）。
 *     PointerSensor 的 activationConstraint.distance=6 → 单击（不移动）不会误触发拖动，
 *     所以「点标签 = 切换」和「拖标签 = 排序」互不干扰；右键也不会触发拖动
 *     （PointerSensor 只响应主键 button===0）。
 *   · 顺序落到后端 sort_order（按数组下标写），并随之刷新 GET /api/tables 的顺序。
 *   · ⚠️ 标签栏 CSS「永远贴在浏览器窗口下边缘」（.lpm-sheetbar）不受影响：
 *     这里只在外层 SortableItem 上复用 .lpm-sheet，保持它仍是 .lpm-sheetbar 的
 *     flex 子项；新增的 .lpm-sheet-body 只做内部排布。
 */
const SheetTabs: React.FC<Props> = ({
  tables, activeId, onSelect, onNew, onRename, onDuplicate, onDelete, onExportOne, onReorder,
}) => {
  const sensors = useDragSensors();
  const ids = tables.map((t) => t.id);

  /** 「右移」= 与右邻交换；「左移」= 与左邻交换（到边界则菜单项置灰） */
  const shift = (t: TableMeta, dir: 'left' | 'right') => {
    const i = ids.indexOf(t.id);
    const j = dir === 'left' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    next[i] = ids[j];
    next[j] = ids[i];
    onReorder(next);
  };

  const menuFor = (t: TableMeta, idx: number): MenuProps['items'] => [
    { key: 'rename', label: '重命名' },
    { key: 'duplicate', label: '复制工作表' },
    { key: 'export', label: '导出该表' },
    { type: 'divider' },
    { key: 'left', label: '左移', disabled: idx <= 0 },
    { key: 'right', label: '右移', disabled: idx >= tables.length - 1 },
    { type: 'divider' },
    { key: 'delete', label: '删除工作表', danger: true },
  ];

  const handleMenu = (t: TableMeta, key: string) => {
    if (key === 'rename') onRename(t);
    else if (key === 'duplicate') onDuplicate(t);
    else if (key === 'delete') onDelete(t);
    else if (key === 'export') onExportOne(t);
    else if (key === 'left' || key === 'right') shift(t, key);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const next = reorderIds(ids, e);
    if (next) onReorder(next);
  };

  return (
    <div className="lpm-sheetbar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          {tables.map((t, idx) => (
            // ⚠️ 结构：SortableItem(外层, 带 dnd listeners, = flex 子项 .lpm-sheet)
            //         └ Dropdown(右键菜单, 会把 onContextMenu 克隆到它的子元素上)
            //             └ div.lpm-sheet-body(内层, 承接受控事件, 真正的点击/右键命中区)
            //   Dropdown 只能把自己的事件挂到「原生 DOM 子元素」上，所以它必须在
            //   SortableItem 里面、包住一个 div —— 反过来挂在 SortableItem 上会被吞掉。
            <SortableItem
              key={t.id}
              id={t.id}
              className={'lpm-sheet' + (t.id === activeId ? ' active' : '')}
            >
              <Dropdown
                trigger={['contextMenu']}
                menu={{ items: menuFor(t, idx), onClick: ({ key }) => handleMenu(t, key) }}
              >
                <div
                  className="lpm-sheet-body"
                  data-id={t.id}
                  onClick={() => onSelect(t.id)}
                  title={`${t.name}（${TYPE_LABEL[t.type] || t.type}）— 拖动排序 · 右键更多操作`}
                >
                  <span>{t.name}</span>
                  <span style={{ fontSize: 10, color: '#aaa' }}>{TYPE_LABEL[t.type] || t.type}</span>
                </div>
              </Dropdown>
            </SortableItem>
          ))}
        </SortableContext>
      </DndContext>
      <div className="lpm-sheet-add" onClick={onNew} title="新建工作表">
        ＋
      </div>
    </div>
  );
};

export default SheetTabs;

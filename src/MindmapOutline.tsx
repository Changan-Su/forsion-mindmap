// 大纲侧栏:与画布**同一份数据**的另一种投影(原型分析文档 §6.8 —— 大纲和导图绝不能各存一套)。
// 这里只做导航与结构:点=选中(画布同步高亮)、双击=跳到画布里编辑、折叠开关共用同一个 `c` 位、
// 选中后 Tab/Enter/Delete 等键仍由画布的键盘层处理(焦点点完就还给画布根)。
// 文字编辑不在大纲里做:节点正文是完整的 Amadeus 块(可含嵌入/图片/数据库),塞进一行输入框只会失真。
export interface OutlineRow {
  id: string
  depth: number
  label: string
  kids: number
  collapsed: boolean
  kind: 'node' | 'summary'
}

export function MindmapOutline({
  rows,
  selected,
  onSelect,
  onEdit,
  onToggle,
  onClose,
}: {
  rows: OutlineRow[]
  selected: Set<string>
  onSelect: (id: string, additive: boolean) => void
  onEdit: (id: string) => void
  onToggle: (id: string) => void
  onClose: () => void
}) {
  return (
    <div className="mmv-outline" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mmv-outline-head">
        <span>大纲</span>
        <button title="关闭大纲" onClick={onClose}>✕</button>
      </div>
      <div className="mmv-outline-body">
        {rows.map((r) => (
          <div
            key={r.id}
            className="mmv-outline-row"
            data-selected={selected.has(r.id) || undefined}
            style={{ paddingLeft: 6 + r.depth * 14 }}
            onClick={(e) => onSelect(r.id, e.metaKey || e.ctrlKey || e.shiftKey)}
            onDoubleClick={() => onEdit(r.id)}
            title={r.label}
          >
            {r.kids > 0 ? (
              <button
                className="mmv-outline-caret"
                onClick={(e) => {
                  e.stopPropagation()
                  onToggle(r.id)
                }}
              >
                {r.collapsed ? '›' : '⌄'}
              </button>
            ) : (
              <span className="mmv-outline-dot">·</span>
            )}
            {/* 「概要」徽标放在 label 之外:label 里只留节点文本本身(否则任何按文本比对的地方
                —— 搜索、断言、复制 —— 都会把徽标当成内容的一部分)。 */}
            {r.kind === 'summary' && <span className="mmv-outline-tag">概要</span>}
            <span className="mmv-outline-label">{r.label || <i>空节点</i>}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

import { describe, it, expect } from 'vitest'
import { nodeLabel, toOutline, toOpml, parseOutline } from '../src/mmOutline'

const tree = [
  { text: '中心', children: [{ text: '甲', children: [{ text: '甲1', children: [] }] }, { text: '乙', children: [] }] },
]

describe('mmOutline', () => {
  it('nodeLabel 取首个非空行并剥 markdown 前缀', () => {
    expect(nodeLabel('## 标题\n正文')).toBe('标题')
    expect(nodeLabel('\n\n- [ ] 待办项  ')).toBe('待办项')
    expect(nodeLabel('> 引用')).toBe('引用')
    expect(nodeLabel('')).toBe('')
  })

  it('导出缩进大纲', () => {
    expect(toOutline(tree)).toBe('- 中心\n  - 甲\n    - 甲1\n  - 乙')
  })

  it('导出 OPML 并转义 XML', () => {
    const x = toOpml([{ text: 'a & b <c>', children: [] }], '图 "1"')
    expect(x).toContain('<outline text="a &amp; b &lt;c&gt;"/>')
    expect(x).toContain('<title>图 &quot;1&quot;</title>')
  })

  it('大纲往返无损', () => {
    expect(parseOutline(toOutline(tree))).toEqual(tree)
  })

  it('缩进宽度自适应(4 空格 / Tab),列表符号可有可无', () => {
    expect(parseOutline('root\n    kid\n        grand')).toEqual([
      { text: 'root', children: [{ text: 'kid', children: [{ text: 'grand', children: [] }] }] },
    ])
    expect(parseOutline('* a\n\t- b')).toEqual([{ text: 'a', children: [{ text: 'b', children: [] }] }])
  })

  it('纯 markdown 标题按 # 级数分层', () => {
    expect(parseOutline('# 一\n## 一甲\n## 一乙\n# 二')).toEqual([
      { text: '一', children: [{ text: '一甲', children: [] }, { text: '一乙', children: [] }] },
      { text: '二', children: [] },
    ])
  })

  it('跳级缩进不造幽灵父级,空文本得空树', () => {
    // 第二行直接缩进三级 —— 只能挂到最近的合法父级,不凭空补中间节点
    expect(parseOutline('- a\n      - deep')).toEqual([{ text: 'a', children: [{ text: 'deep', children: [] }] }])
    expect(parseOutline('')).toEqual([])
    expect(parseOutline('\n\n   \n')).toEqual([])
  })
})

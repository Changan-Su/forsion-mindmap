// 外来 frontmatter(fmExtra)的读写。与宿主 shared/amadeus/db/pageFrontmatter.ts 同一套语义 ——
// 迁成插件后这段必须随包走:seam 只递给我们一段**文本**,怎么在里面外科式改自己的键是插件的事。
//
// ⚠️ fmExtra 是**公共空间**:用户手写的键、别的插件的键都在同一份里。所以只能 patch,绝不整段重写。
//    「外科式」是字面意思(2026-08-14 评审后收紧):只动自己那个键所在的行,其余行**逐字保全** ——
//    此前的 parse→改对象→stringify 会把用户的 YAML 注释、引号风格、键序整份重排,宿主契约明写
//    fmExtra 是 round-trips verbatim 的空间,重排即数据损伤。
// ⚠️ 解析失败(用户把 YAML 改坏了)一律**拒绝落盘**而不是按空对象覆盖 —— 后者会把人家的内容抹掉。
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** 宿主保留的单行键,插件永远不许碰(尤其 amadeus_layout:它有 zod 校验且不 passthrough)。 */
const RESERVED = /^(amadeus_page|amadeus_schema|amadeus_layout):/

export function parseFmObject(fmExtra: string): Record<string, unknown> {
  if (!fmExtra.trim()) return {}
  try {
    const v: unknown = parseYaml(fmExtra)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 在 fmExtra 上应用 patch(值 = undefined 删键),返回新文本;既有内容解析不了就返回 null 拒改。
 *  行级外科:只替换/删除/追加 patch 里那些键自己的行(含块式值的缩进续行),别人的行原样不动。 */
export function patchFmExtraText(fmExtra: string, patch: Record<string, unknown>): string | null {
  if (fmExtra.trim()) {
    // 仍要求整段可解析:键行定位在坏 YAML 上不可靠,宁可拒改也不能蒙着切错行。
    try {
      const v: unknown = parseYaml(fmExtra)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    } catch {
      return null
    }
  }
  const lines = fmExtra ? fmExtra.replace(/\n+$/, '').split('\n') : []
  for (const [k, v] of Object.entries(patch)) {
    if (RESERVED.test(`${k}:`)) continue
    const re = new RegExp(`^["']?${escRe(k)}["']?\\s*:`)
    const at = lines.findIndex((l) => re.test(l))
    let end = at
    if (at >= 0) {
      end = at + 1
      while (end < lines.length && /^[ \t]/.test(lines[end])) end++ // 块式值的缩进续行归本键一并换掉
    }
    const rendered = v === undefined ? [] : stringifyYaml({ [k]: v }).replace(/\n+$/, '').split('\n')
    if (at >= 0) lines.splice(at, end - at, ...rendered)
    else if (rendered.length) lines.push(...rendered)
  }
  const out = lines.join('\n')
  return out.trim() ? out : ''
}

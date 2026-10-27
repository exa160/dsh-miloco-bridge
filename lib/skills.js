/**
 * Skill registration.
 *
 * The bundle ships its skills as plain `<name>/SKILL.md` files next to the
 * code. They are registered at runtime so the plugin stays a single
 * installable unit: no separate copy in `~/.dsh/skills/`, and editing a
 * skill file only needs a plugin reload.
 *
 * The frontmatter parser is intentionally tiny — the bundled skills use flat
 * `key: value` frontmatter, which is all DSH's skill format needs
 * (`name`, `description`, optional `whenToUse`).
 *
 * @module dsh-miloco-bridge/skills
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding the bundled `<name>/SKILL.md` files. */
export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/**
 * Split a skill file into its frontmatter fields and its body.
 * @param {string} text - Raw file content.
 * @returns {{data: Record<string, string>, body: string}} The parsed parts.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const front = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of front.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

/**
 * Register every bundled skill with the runtime registry.
 *
 * @param {any} ctx - Context carrying the `skills` service.
 * @param {any} [logger] - Logger for warnings.
 * @returns {Promise<(() => void)[]>} The disposers of the registered skills.
 */
export async function registerSkills(ctx, logger) {
  /** @type {(() => void)[]} */
  const disposers = []
  /** @type {string[]} */
  let entries = []
  try {
    entries = (await readdir(SKILLS_DIR, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    logger?.warn?.(`dsh-miloco-bridge: 无法读取技能目录 ${SKILLS_DIR}：${error instanceof Error ? error.message : error}`)
    return disposers
  }

  for (const directory of entries.sort()) {
    let text
    try {
      text = await readFile(join(SKILLS_DIR, directory, 'SKILL.md'), 'utf8')
    } catch {
      logger?.warn?.(`dsh-miloco-bridge: 技能 ${directory} 缺少 SKILL.md，已跳过`)
      continue
    }
    const { data, body } = parseFrontmatter(text)
    const name = (data.name ?? directory).trim()
    const description = (data.description ?? '').trim()
    if (!description) {
      logger?.warn?.(`dsh-miloco-bridge: 技能 ${name} 缺少 description，已跳过`)
      continue
    }
    try {
      disposers.push(ctx.skills.register({
        name,
        description,
        content: body,
        ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
      }))
    } catch (error) {
      logger?.warn?.(`dsh-miloco-bridge: 注册技能 ${name} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  return disposers
}

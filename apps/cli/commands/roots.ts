import { loadConfig } from '../../../packages/core/src/config'
import { output, EXIT_SUCCESS, type OutputOptions } from '../core'
import { getEffectiveConfigPath } from '../helpers'

export async function cmdRoots(opts: OutputOptions, getConfigPath: () => string): Promise<number> {
  const configPath = getEffectiveConfigPath(getConfigPath)
  const config = await loadConfig(configPath)
  const disabled = new Set(config.index.disabled)
  const namespaceMap = new Map<string, string[]>()

  for (const [name, value] of Object.entries(config.namespaces)) {
    if (typeof value === 'string') {
      const list = namespaceMap.get(value) ?? []
      list.push(name)
      namespaceMap.set(value, list)
    }
  }

  const roots = config.index.roots.map(root => {
    const namespaces = namespaceMap.get(root) ?? []
    return {
      path: root,
      disabled: disabled.has(root),
      namespaces,
    }
  })

  if (opts.json) {
    output({ roots }, opts)
  } else if (roots.length === 0) {
    output('No roots configured.', opts)
  } else {
    const lines = roots.map(root => {
      const parts: string[] = [root.path]
      if (root.disabled) parts.push('(disabled)')
      if (root.namespaces.length > 0) parts.push(`(namespaces: ${root.namespaces.join(', ')})`)
      return parts.join(' ')
    })
    output(lines.join('\n'), opts)
  }

  return EXIT_SUCCESS
}

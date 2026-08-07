// A preset row: registers one tool and one prompt section, both named from
// config. Import-free on purpose — the Loader resolves entry modules through
// Node's ESM resolver, which cannot see this workspace's TypeScript sources.
export const name = 'contribute'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: `fixture tool ${config.tool}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(config.tool),
  }))
  ctx.effect(() => ctx.systemPrompt.section({
    name: `preset:${config.tool}`,
    order: 10,
    text: `section for ${config.tool}`,
  }))
  // Reconfiguring a live row runs the Loader's `internal/update` waterfall,
  // which persists the owning tree. That is the trigger reaching the preset
  // tree's `write` while the subtree is still mounted; tearing the agent down
  // instead stops earlier, in the loader's own "tree is being disposed" case.
  globalThis.__RECONFIGURE__ = tool => ctx.fiber.update({ ...config, tool })
}

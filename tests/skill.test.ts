import { describe, expect, it, vi } from 'vitest'
import { abortable } from '../src/abort.ts'
import { createEntrySkillProvider, DESCRIPTION_MAX_CHARS, describeApps, renderCatalog, renderEntrySkill } from '../src/skill/entry.ts'
import type { AppManifest } from '../src/settings/contract.ts'

const order: AppManifest = { id: 'order-service', name: '订单服务', description: '下单 | 支付', aliases: ['订单'], logHints: ['OrderController'], skill: 'log-analysis' }

describe('entry skill', () => {
  it('lists usable applications in the catalog', () => {
    expect(renderCatalog([order])).toContain('| `order-service` | 订单服务 | 下单 \\| 支付 | 订单 | `OrderController` |')
    expect(renderCatalog([])).toContain('当前没有可用的应用')
    const body = renderEntrySkill([order], 3, false)
    expect(body).toContain('`guanxiang_dispatch`')
    expect(body).toContain('最多 3 个')
    expect(body).not.toContain('guanxiang_propose_skill')
    expect(renderEntrySkill([order], 3, true)).toContain('然后调用 `guanxiang_propose_skill`')
  })

  it('is user-invocable only and renders the live catalog on each load', async () => {
    let apps: AppManifest[] = []
    const ready = Promise.withResolvers<void>()
    const { factory, invalidate } = createEntrySkillProvider({ prepare: signal => abortable(ready.promise, signal), apps: () => apps, maxAppsPerRequest: () => 4, skillUpdates: () => false, autoInvoke: false, inRepositories: () => false })
    const control = { signal: new AbortController().signal, invalidate: vi.fn() }
    const provider = factory(control)
    const [candidate] = await provider.list({})
    expect(candidate).toMatchObject({ name: 'guanxiang', invocation: { modelInvocable: false, userInvocable: true }, rank: 600 })
    let loaded = false
    const loading = provider.get(candidate!, {}).then((skill) => { loaded = true; return skill })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(loaded).toBe(false)
    ready.resolve()
    expect((await loading)?.content).toContain('当前没有可用的应用')
    const aborted = AbortSignal.abort(new Error('stop'))
    await expect(provider.get(candidate!, { signal: aborted })).rejects.toThrow('stop')
    apps = [order]
    expect((await provider.get(candidate!, {}))?.content).toContain('order-service')
    // Without automatic loading the listed entry does not depend on the applications.
    invalidate()
    expect(control.invalidate).not.toHaveBeenCalled()
  })

  it('lets top-level agents load it when applications are usable, and lists it nowhere inside the repositories', async () => {
    let apps: AppManifest[] = []
    const { factory, invalidate } = createEntrySkillProvider({
      prepare: () => Promise.resolve(),
      apps: () => apps,
      maxAppsPerRequest: () => 4,
      skillUpdates: () => false,
      autoInvoke: true,
      inRepositories: cwd => cwd.startsWith('/repos'),
    })
    const control = { signal: new AbortController().signal, invalidate: vi.fn() }
    const provider = factory(control)
    const [empty] = await provider.list({ cwd: '/project' })
    expect(empty).toMatchObject({ invocation: { modelInvocable: false, userInvocable: true }, whenToUse: '仅在用户输入 /guanxiang 时使用。' })

    apps = [order]
    invalidate()
    expect(control.invalidate).toHaveBeenCalledTimes(1)
    const [listed] = await provider.list({ cwd: '/project' })
    expect(listed).toMatchObject({ name: 'guanxiang', invocation: { modelInvocable: true, userInvocable: true } })
    expect(listed?.description).toContain('订单服务（order-service、订单、OrderController）')
    expect(await provider.list({ cwd: '/repos/.snapshots/order-service/abc' })).toEqual([])
    invalidate()
    expect(control.invalidate).toHaveBeenCalledTimes(1)
    const skill = await provider.get(listed!, {})
    expect(skill).toMatchObject({ invocation: { modelInvocable: true }, description: listed?.description })
    expect(skill?.content).toContain('按普通方式完成用户的请求')
  })

  it('fits the description within the catalog budget and counts applications left out', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ ...order, id: `app-${index}`, name: `应用${index}` }))
    const text = describeApps(many)
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS)
    expect(text).toMatch(/；另有 \d+ 个应用。日志与这些应用无关时不要使用。$/)
    expect(text).toContain('应用0（app-0、订单、OrderController）')
    const huge = { ...order, aliases: ['x'.repeat(DESCRIPTION_MAX_CHARS)] }
    expect(describeApps([huge])).toContain('1 个应用')
  })
})

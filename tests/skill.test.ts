import { describe, expect, it, vi } from 'vitest'
import { createEntrySkillProvider, renderCatalog, renderEntrySkill } from '../src/skill/entry.ts'
import type { AppManifest } from '../src/settings/contract.ts'

const order: AppManifest = { id: 'order-service', name: '订单服务', description: '下单 | 支付', aliases: ['订单'], logHints: ['OrderController'], skill: 'log-analysis' }

describe('entry skill', () => {
  it('lists usable applications in the catalog', () => {
    expect(renderCatalog([order])).toContain('| `order-service` | 订单服务 | 下单 \\| 支付 | 订单 | `OrderController` |')
    expect(renderCatalog([])).toContain('当前没有可用的应用')
    const body = renderEntrySkill([order], 3)
    expect(body).toContain('`guanxiang_dispatch`')
    expect(body).toContain('最多 3 个')
  })

  it('is user-invocable only and renders the live catalog on each load', async () => {
    let apps: AppManifest[] = []
    const ready = Promise.withResolvers<void>()
    const { factory, invalidate } = createEntrySkillProvider({ ready: () => ready.promise, apps: () => apps, maxAppsPerRequest: () => 4 })
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
    invalidate()
    expect(control.invalidate).toHaveBeenCalledTimes(1)
  })
})

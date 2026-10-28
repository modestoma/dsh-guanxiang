import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { credentialEnvironment, credentialFor, isAcceptedToken, normalizeCredentialUrl } from '../src/repos/credentials.ts'
import type { GitCredentialSpec } from '../src/settings/contract.ts'

const spec = (url: string, tokenEnv = 'GITLAB_TOKEN'): GitCredentialSpec => ({ url, username: 'oauth2', tokenEnv })

describe('access token addresses', () => {
  it('normalizes the prefix to scheme, lowercase host, and path without a trailing slash', () => {
    expect(normalizeCredentialUrl('https://GitLab.Example.com/')).toBe('https://gitlab.example.com')
    expect(normalizeCredentialUrl('http://git.example.com:8080/gitlab/')).toBe('http://git.example.com:8080/gitlab')
  })

  it.each(['git@gitlab.example.com:team/app.git', 'ssh://gitlab.example.com', 'https://user:pw@gitlab.example.com', 'https://gitlab.example.com/?a=1', 'gitlab.example.com'])('refuses %s', (url) => {
    expect(normalizeCredentialUrl(url)).toBeUndefined()
  })

  it('picks the longest matching prefix on a path segment boundary', () => {
    const specs = [spec('https://gitlab.example.com', 'ALL'), spec('https://gitlab.example.com/team', 'TEAM')]
    expect(credentialFor('https://gitlab.example.com/team/app.git', specs)?.tokenEnv).toBe('TEAM')
    expect(credentialFor('https://gitlab.example.com/teammate/app.git', specs)?.tokenEnv).toBe('ALL')
    expect(credentialFor('http://gitlab.example.com/team/app.git', specs)).toBeUndefined()
    expect(credentialFor('https://gitlab.example.com:8443/team/app.git', specs)).toBeUndefined()
    expect(credentialFor('git@gitlab.example.com:team/app.git', specs)).toBeUndefined()
    expect(credentialFor('/srv/git/app', specs)).toBeUndefined()
  })

  it('validates the configuration and defaults the username', () => {
    expect(resolveConfig({ gitCredentials: [{ url: 'https://GitLab.example.com/', tokenEnv: 'GITLAB_TOKEN' }] }).gitCredentials)
      .toEqual([spec('https://gitlab.example.com')])
    expect(() => resolveConfig({ gitCredentials: [{ url: 'https://a.example.com', tokenEnv: 'glpat-123' }] })).toThrow(/令牌名称/)
    expect(() => resolveConfig({ gitCredentials: [{ url: 'https://a.example.com', tokenEnv: 'A', token: 'x' }] })).toThrow()
    expect(() => resolveConfig({ gitCredentials: [{ url: 'https://a.example.com', tokenEnv: 'A' }, { url: 'https://a.example.com/', tokenEnv: 'B' }] })).toThrow(/重复的令牌地址/)
  })
})

describe('access token environment', () => {
  it('scopes a helper to the host after the existing command-line configuration', () => {
    const env = credentialEnvironment(spec('https://gitlab.example.com/team'), 'glpat-x', { GIT_CONFIG_COUNT: '1' })
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'credential.https://gitlab.example.com.helper',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'credential.https://gitlab.example.com.helper',
      GUANXIANG_GIT_USERNAME: 'oauth2',
      GUANXIANG_GIT_TOKEN: 'glpat-x',
    })
    expect(env.GIT_CONFIG_VALUE_2).not.toContain('glpat-x')
  })

  it('refuses token values that would break the helper protocol', () => {
    expect(isAcceptedToken('glpat-abc')).toBe(true)
    expect(isAcceptedToken('')).toBe(false)
    expect(isAcceptedToken('a\nb')).toBe(false)
    expect(isAcceptedToken('x'.repeat(4097))).toBe(false)
  })
})

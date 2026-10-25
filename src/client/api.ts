/**
 * 设置面板的同源 HTTP 客户端，直接请求 Host 半侧注册的 `/guanxiang/*` 路由。
 *
 * @module dsh-guanxiang/client/api
 */

import { SETTINGS_ROUTE, STATE_ROUTE, SYNC_ROUTE } from '../settings/contract.ts'
import type { EditableSettings, MutationError, MutationOk, StateWire } from '../settings/contract.ts'

/**
 * Error text of a value thrown by a request.
 * @param error - thrown value.
 * @returns message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch one Host route. Routes are absolute pathnames, but the browser
 * addresses them relative to the DSH document so a reverse proxy that mounts
 * DSH under a prefix still routes them with its scoped login cookie.
 */
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(route.slice(1), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init?.body === undefined ? {} : { 'content-type': 'application/json' } },
    })
  } catch (error) {
    throw new Error(`无法连接设置接口：${messageOf(error)}`)
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Non-JSON bodies (proxy errors) are reported by HTTP status below.
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok) {
    const error = (body as Partial<MutationError>).error
    throw new Error(typeof error === 'string' && error !== '' ? error : `HTTP ${response.status}`)
  }
  return body as T
}

/** @returns the panel state. */
export function fetchState(): Promise<StateWire> {
  return request<StateWire>(STATE_ROUTE)
}

/**
 * Save the complete editable settings.
 * @param settings - settings to persist.
 * @returns the new state.
 */
export async function saveSettings(settings: EditableSettings): Promise<StateWire> {
  return (await request<MutationOk>(SETTINGS_ROUTE, { method: 'PUT', body: JSON.stringify(settings) })).state
}

/** @returns the state after removing every panel override. */
export async function resetSettings(): Promise<StateWire> {
  return (await request<MutationOk>(SETTINGS_ROUTE, { method: 'DELETE' })).state
}

/**
 * Re-sync one repository or all of them.
 * @param url - repository address; omitted syncs all.
 * @returns the state right after the sync started.
 */
export async function syncRepos(url?: string): Promise<StateWire> {
  return (await request<MutationOk>(SYNC_ROUTE, { method: 'POST', body: JSON.stringify(url === undefined ? {} : { url }) })).state
}

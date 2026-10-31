/**
 * 分析请求到 dsh-channels `feishuTopics` 服务的转换：根卡片内容、工作区
 * `analyze/<app>/<errorCode>`、幂等键与指纹，以及服务结果到 HTTP 响应的映射。
 *
 * 只从 `@modesto_ma/dsh-channels/topics` 引入类型；服务在运行时经
 * `ctx.get('feishuTopics')` 取得，版本不符时不调用。
 *
 * @module dsh-logalyze/analyze/topics
 */

import type {
  FeishuTopicService, FeishuTopicsVersion, TopicLaunchResult, TopicLaunchSpec,
} from '@modesto_ma/dsh-channels/topics'
import type { TopicsAvailability } from '../settings/contract.ts'
import { analyzeRequestHash } from './contract.ts'
import type { AnalyzeRequest, AnalyzeResponse } from './contract.ts'

/** Name dsh-channels provides the service under. */
export const FEISHU_TOPICS_SERVICE = 'feishuTopics'

/** The `feishuTopics` contract version this plugin speaks. */
export const FEISHU_TOPICS_VERSION: FeishuTopicsVersion = 1

/** Result of looking the service up. */
export type TopicsLookup =
  | { readonly availability: 'ready'; readonly service: FeishuTopicService }
  | { readonly availability: Exclude<TopicsAvailability, 'ready'> }

/**
 * Classify the value `ctx.get('feishuTopics')` returned. The provider is
 * another package, so its contract version is checked at run time.
 * @param value - the looked-up service, or undefined.
 * @returns the usable service, or why there is none.
 */
export function lookupTopics(value: unknown): TopicsLookup {
  if (value === undefined || value === null) return { availability: 'missing' }
  if ((value as { version?: unknown }).version !== FEISHU_TOPICS_VERSION) return { availability: 'incompatible' }
  return { availability: 'ready', service: value as FeishuTopicService }
}

/**
 * The topic one analyze request starts.
 * @param request - the validated request.
 * @param idempotencyKey - the request's `Idempotency-Key`, used unchanged as the launch key.
 * @returns the launch spec.
 */
export function analyzeTopicSpec(request: AnalyzeRequest, idempotencyKey: string): TopicLaunchSpec {
  return {
    key: idempotencyKey,
    fingerprint: analyzeRequestHash(request),
    chatId: request.chatId,
    requesterUserId: request.requesterUserId,
    card: {
      title: '日志分析',
      taskName: '分析',
      lead: [
        { text: `于 ${request.triggeredAt} 发起了对 ` },
        { text: request.app, bold: true },
        { text: ' 应用 ' },
        { text: request.errorCode, bold: true },
        { text: ' 错误码不良日志的分析。' },
      ],
      links: { nameHeader: '日志', linkHeader: '详情页', rows: request.logDetails },
    },
    workspace: {
      segments: ['analyze', request.app, request.errorCode],
      title: `日志分析 · ${request.app} · ${request.errorCode}`,
    },
    prompt: request.prompt,
  }
}

/**
 * HTTP answer of one launch result.
 * @param result - what the service answered.
 * @returns status and body.
 */
export function analyzeResponseOf(result: TopicLaunchResult): AnalyzeResponse {
  if (result.ok) return { status: 202, body: { ok: true, chatId: result.chatId, messageId: result.messageId } }
  switch (result.code) {
    case 'not-connected': return refused(503, result.message)
    case 'forbidden-chat': return refused(403, result.message)
    case 'key-conflict': return refused(409, 'Idempotency-Key 已被内容不同的请求使用')
    case 'send-failed': return refused(502, result.message)
    // The request passed this plugin's own validation, so a refused spec is a
    // disagreement between the two plugins, not a client error.
    case 'invalid': return refused(500, `分析请求处理失败：${result.message}`)
    default: return refused(500, `分析请求处理失败：${String((result as { message?: unknown }).message)}`)
  }
}

/**
 * Start the analysis topic of one validated request.
 * @param topics - the `feishuTopics` service.
 * @param request - the validated request.
 * @param idempotencyKey - the request's `Idempotency-Key`.
 * @returns the HTTP answer.
 */
export async function launchAnalysis(topics: FeishuTopicService, request: AnalyzeRequest, idempotencyKey: string): Promise<AnalyzeResponse> {
  return analyzeResponseOf(await topics.launch(analyzeTopicSpec(request, idempotencyKey)))
}

function refused(status: number, error: string): AnalyzeResponse {
  return { status, body: { ok: false, error } }
}

// @env node
import type { Environment } from '../runtime/types.ts'

export type NoticeFetch = (url: string, init: RequestInit) => Promise<Response>
export type NoticeResult = 'skipped' | 'sent' | 'failed'

export async function notify(
  content: string,
  env: Environment = process.env,
  fetcher: NoticeFetch = fetch,
): Promise<NoticeResult> {
  const url = env.WECOM_BOT_URL?.trim()
  if (!url) return 'skipped'
  const bytes = Buffer.from(content, 'utf8')
  const bounded =
    bytes.length <= 4096
      ? content
      : new TextDecoder().decode(bytes.subarray(0, 4093), { stream: true }) + '…'
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: bounded } }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    if (!response.ok) {
      console.error(`[notice] 企业微信返回 HTTP ${response.status}`)
      return 'failed'
    }
    const body: unknown = await response.json()
    const errcode = body && typeof body === 'object' && 'errcode' in body ? body.errcode : undefined
    if (errcode !== 0) {
      console.error(
        '[notice] 企业微信返回错误码：',
        typeof errcode === 'number' ? errcode : '无效响应',
      )
      return 'failed'
    }
    return 'sent'
  } catch {
    // 错误可能包含带密钥的 Webhook URL，仅记录固定诊断。
    console.error('[notice] 发送失败：网络、超时或响应无效')
    return 'failed'
  }
}

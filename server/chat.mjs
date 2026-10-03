/**
 * 流式对话代理：复用 config.mjs 的档位配置（默认 text 档）。
 * 上游按 OpenAI 兼容 /chat/completions (stream=true) 调用，
 * 解析 SSE 后把增量文本通过 onDelta 回调透出。
 */
import { loadConfig, getProfile, PROFILE_KEYS, PROFILE_LABELS } from './config.mjs';
import { describeFetchError } from './net.mjs';

export async function streamChat({ messages, profile = 'text', temperature }, onDelta) {
  const cfg = loadConfig().llm;
  const key = PROFILE_KEYS.includes(profile) ? profile : 'text';
  const prof = getProfile(key);
  if (!prof.apiKey) throw new Error('未配置 LLM API Key（回下载器点右上角「LLM 设置」）');
  const base = String(prof.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 LLM 接口地址');

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${prof.apiKey}`,
      },
      body: JSON.stringify({
        model: prof.model,
        messages,
        temperature: temperature ?? cfg.temperature ?? 0.2,
        stream: true,
      }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (err) {
    throw describeFetchError(err, { base, label: PROFILE_LABELS?.[key] || key, timeoutSec: 300 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 接口 ${res.status}：${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let usage = null;
  let got = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { got += 1; onDelta(delta); }
        if (json.usage) usage = json.usage;
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  }
  return { usage, chunks: got };
}

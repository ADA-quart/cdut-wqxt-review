/** 把 fetch 的网络层错误翻译成用户能看懂的提示（本机推理服务给启动建议） */
export function describeFetchError(err, { base = '', label = '', timeoutSec = 0 } = {}) {
  const code = err?.cause?.code || err?.code || '';
  const name = err?.name || '';
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(String(base));

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`「${label || base}」${timeoutSec ? ` ${timeoutSec} 秒` : ''}未响应，请检查接口地址与网络`);
  }
  if (local) {
    return new Error(
      `连不上本机推理服务 ${base}${code ? `（${code}）` : ''}：` +
      '请先启动 Ollama / vLLM（例如 ollama serve），确认地址端口后再试'
    );
  }
  return new Error(`连不上「${label || base}」接口 ${base}${code ? `（${code}）` : ''}：${err?.message || err}`);
}

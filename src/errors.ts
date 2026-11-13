/** Only deliberately constructed messages cross the UI boundary. Never expose raw provider payloads. */
export class UserError extends Error {}

const userErrors = new Set<typeof UserError>([UserError]);
const requestErrors = new Set<typeof RequestError>();
export function registerErrors(module: { UserError?: typeof UserError; RequestError?: typeof RequestError }) {
  if (typeof module.UserError === 'function') userErrors.add(module.UserError);
  if (typeof module.RequestError === 'function') requestErrors.add(module.RequestError);
}
export function isUserError(error: unknown): error is UserError { return [...userErrors].some(type => error instanceof type); }
export function isRequestError(error: unknown): error is RequestError { return error instanceof RequestError || [...requestErrors].some(type => error instanceof type); }

export function connectionError(error: unknown) {
  if (isUserError(error)) return error.message;
  const value = error as { code?: string; status?: number; cause?: { code?: string }; name?: string } | undefined;
  const code = value?.code ?? value?.cause?.code;
  if (code === 'ENOENT') return '找不到 MCP 启动程序。检查 command 路径或 PATH。';
  if (code === 'ECONNREFUSED') return 'MCP 拒绝连接。检查服务是否启动及端口是否正确。';
  if (code === 'ENOTFOUND') return '无法解析 MCP 地址。检查主机名和网络。';
  if (value?.status === 401 || value?.status === 403) return `MCP 认证失败（HTTP ${value.status}）。检查 headers 和凭据环境变量。`;
  if (value?.status) return `MCP 返回 HTTP ${value.status}。检查服务地址和传输协议。`;
  if (value?.name?.includes('Timeout') || code === 'ETIMEDOUT') return 'MCP 连接超时。检查服务和网络，必要时调整 timeout（秒）。';
  return 'MCP 连接或工具发现失败。运行 mcp test <名称> 检查 command、url 和服务日志。';
}

export function userMessage(error: unknown, fallback = '操作失败。运行 .\\switch.ps1 doctor 查看诊断。') {
  return isUserError(error) ? error.message : fallback;
}

export function modelError(message = '') {
  if (/\b(401|403)\b|authentication|invalid.*api.?key/i.test(message)) return '模型认证失败。请在影刀模型设置中检查 API 凭据。';
  if (/\b429\b|rate.?limit|quota/i.test(message)) return '模型请求被限流或额度不足。请检查模型账户额度，稍后重试。';
  if (/timeout|timed out|ECONN|fetch failed/i.test(message)) return '无法完成模型连接。请检查 API 地址、网络和模型服务状态。';
  if (/context.{0,30}(limit|length)|maximum context/i.test(message)) return '模型上下文超出限制。请缩短附件或新建会话后重试。';
  return '模型请求失败。请检查影刀模型配置及服务状态。';
}
export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

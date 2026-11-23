/** 可预期的请求错误：状态码会原样回给客户端，其余错误统一按 500 处理。 */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

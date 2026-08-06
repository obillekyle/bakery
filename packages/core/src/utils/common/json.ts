export class JsonResponseData<T = any> implements JsonResponse<T> {
  time: number = 0

  constructor(
    public status: number,
    public message: string,
    public data?: T,
  ) {}

  toJson() {
    return JSON.stringify({
      time: this.time,
      status: this.status,
      message: this.message,
      data: this.data,
    })
  }

  toObject() {
    return {
      time: this.time,
      status: this.status,
      message: this.message,
      data: this.data,
    }
  }
}

export function jsonResponse<T>(
  status: number,
  message: string,
  data?: T,
): JsonResponseData<T> {
  return new JsonResponseData(status, message, data)
}

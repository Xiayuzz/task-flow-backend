export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', '资源不存在'));
}

export function errorHandler(err, req, res, next) { // eslint-disable-line
  if (err instanceof AppError) {
    return res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
  }
  console.error(err);
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器错误' });
}

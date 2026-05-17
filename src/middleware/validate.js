import { ZodError } from 'zod';
import { AppError } from '../utils/error.js';

export function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        const details = {};
        for (const issue of e.issues) {
          const path = issue.path.join('.') || 'root';
          details[path] = issue.message;
        }
        return next(new AppError(422, 'UNPROCESSABLE', '参数校验失败', details));
      }
      next(e);
    }
  };
}

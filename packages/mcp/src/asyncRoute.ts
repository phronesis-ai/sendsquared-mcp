import type { Request, Response, NextFunction, RequestHandler } from "express"

/*
  Express 4 ignores the promise an async handler returns, so a rejection
  inside one becomes an unhandled rejection and Node exits the process. This
  hands the rejection to next() so the error middleware answers the request.
*/
export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

/**
 * DARKONYX PANEL — async route safety wrapper.
 * Express 4 does not catch rejected promises from async handlers: a single
 * rejected `await` would reject outside the request lifecycle and (historically)
 * take the process down. Wrapping the router stack keeps every route honest.
 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrap(fn) {
  if (typeof fn !== 'function') return fn;
  // routers / middlewares with 4 args keep their signature
  if (fn.length === 4) {
    return function (err, req, res, next) {
      try {
        const out = fn(err, req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
      } catch (e) { next(e); }
    };
  }
  return function (req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (e) { next(e); }
  };
}

function hardenRouter(router) {
  if (!router || router.__hardened) return router;
  router.__hardened = true;
  for (const method of METHODS) {
    const original = router[method];
    if (typeof original !== 'function') continue;
    router[method] = function (...handlers) {
      return original.apply(this, handlers.map(wrap));
    };
  }
  return router;
}

module.exports = { wrap, hardenRouter };

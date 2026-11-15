// Worker entry. Only /api/* reaches this code (see run_worker_first in
// wrangler.jsonc); every other request is served straight from static assets.
import { handleLead, methodNotAllowed } from './lead.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/lead') {
      return request.method === 'POST' ? handleLead(request, env) : methodNotAllowed();
    }

    return env.ASSETS.fetch(request);
  },
};

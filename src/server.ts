import { env } from "#src/env/server.js";

// Phase 0 placeholder: proves env validation at boot. Phase 3 replaces this with the Express app.
console.log(`Environment OK (${env.NODE_ENV}); HTTP server arrives in Phase 3.`);

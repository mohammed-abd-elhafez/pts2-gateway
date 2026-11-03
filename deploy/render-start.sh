#!/bin/sh
# Start command on Render (set as the Docker command): migrations, then the demo data (does nothing unless DEMO_SEED=true),
# then the server. exec makes node the main process, so a stop signal reaches it and shutdown is graceful.
set -e
node dist/scripts/migrate.js
node dist/scripts/seed-demo.js
exec node dist/src/server.js

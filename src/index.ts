import { readFileSync } from 'node:fs';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { createLogger } from './logger.js';
import { CleanupService } from './services/cleanup.js';
import { FcmMessenger } from './services/fcm.js';
import { Notifier } from './services/notifier.js';
import { PlacesClient } from './services/places.js';
import { UsageGuard } from './services/usage.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const firebase = initFirebase(config);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const notifier = new Notifier(firebase.db, new FcmMessenger(firebase.messaging), logger);
const app = createApp({
  db: firebase.db,
  verifyIdToken: firebase.verifyIdToken,
  notifier,
  places: new PlacesClient(config.mapsServerKey, new UsageGuard(firebase.db)),
  cleanup: new CleanupService(firebase.db, notifier, logger),
  cronSecret: config.cronSecret,
  logger,
  version,
});

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, places: Boolean(config.mapsServerKey), cron: Boolean(config.cronSecret) },
    'tour-board-backend listening',
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
  });
}

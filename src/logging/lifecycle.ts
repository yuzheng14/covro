import { errorFields } from './fields.js';
import type { Logger } from './logger.js';

/** Fatal exceptions terminate with status 1; never continue serving or print raw error content. */
export function monitorCrashes(logger: Logger, flush: () => void): () => void {
  const monitor = (error: Error) => {
    logger.fatal('process.uncaught_exception', errorFields(error));
    flush();
    process.exit(1);
  };
  process.on('uncaughtException', monitor);
  return () => process.removeListener('uncaughtException', monitor);
}

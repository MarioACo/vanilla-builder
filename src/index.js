// API programática.
import { loadConfig } from './config.js';
import { runPipeline, VERSION } from './builder.js';

/**
 * Compila un proyecto.
 * @param {{dir?: string, config?: string, overrides?: object, force?: boolean, keepFailed?: boolean, log?: Function}} [opts]
 */
export async function build(opts = {}) {
  const cfg = await loadConfig(opts);
  return runPipeline(cfg, { mode: 'build', force: opts.force, keepFailed: opts.keepFailed, log: opts.log });
}

/** Calcula el plan (dependencias, salida prevista, avisos) sin escribir nada. */
export async function analyze(opts = {}) {
  const cfg = await loadConfig(opts);
  return runPipeline(cfg, { mode: 'analyze', log: opts.log });
}

export { loadConfig, VERSION };
export { BuildError } from './util.js';
export { startServer } from './server.js';

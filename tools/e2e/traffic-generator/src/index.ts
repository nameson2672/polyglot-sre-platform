#!/usr/bin/env node
import { Command } from 'commander';
import { config, type ScenarioConfig } from './config.js';

const program = new Command();

program
  .name('polyglot-traffic')
  .description('Traffic generator for polyglot-sre-platform')
  .version('0.1.0');

function scenarioCommand(name: string, description: string) {
  return program
    .command(name)
    .description(description)
    .option('-r, --rps <n>', 'Requests per second', '5')
    .option('-d, --duration <secs>', 'How long to run (omit for forever)')
    .option('-u, --url <url>', 'checkout-bff base URL', config.checkoutBffUrl)
    .option('-c, --concurrency <n>', 'Max in-flight requests', '10')
    .option('-s, --stats-interval <secs>', 'Print stats every N seconds', '5')
    .option('--customers <n>', 'Rotate through N customer IDs', '10')
    .option('--direct', 'Hit orders-api directly (chaos only)')
    .option('--api-key <key>', 'API key for direct mode', config.ordersApiKey);
}

scenarioCommand('steady', 'Constant RPS, mostly-success (good for leaving running)').action(
  async (opts) => {
    const { run } = await import('./scenarios/steady.js');
    await run(buildConfig(opts, 'steady'));
  },
);

scenarioCommand('spike', 'Ramp from 1 → target RPS over 50s then sustain').action(async (opts) => {
  const { run } = await import('./scenarios/spike.js');
  await run(buildConfig(opts, 'spike'));
});

scenarioCommand('mixed', '80% valid / 20% validation-fail traffic mix').action(async (opts) => {
  const { run } = await import('./scenarios/mixed.js');
  await run(buildConfig(opts, 'mixed'));
});

scenarioCommand('chaos', 'Hit /v1/orders/slow to generate latency-SLO burns').action(
  async (opts) => {
    const { run } = await import('./scenarios/chaos.js');
    await run(buildConfig(opts, 'chaos'));
  },
);

function buildConfig(opts: Record<string, string | boolean | undefined>, scenario: string): ScenarioConfig {
  return {
    url: (opts['url'] as string | undefined) ?? config.checkoutBffUrl,
    rps: Number(opts['rps'] ?? 5),
    duration: opts['duration'] !== undefined ? Number(opts['duration']) : undefined,
    concurrency: Number(opts['concurrency'] ?? 10),
    statsInterval: Number(opts['statsInterval'] ?? opts['stats-interval'] ?? 5),
    customers: Number(opts['customers'] ?? 10),
    scenario,
  };
}

program.parse();

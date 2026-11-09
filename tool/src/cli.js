import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './lib/errors.js';
import { loadModules } from './lib/discover.js';
import { frameworkVersion } from './lib/paths.js';
import { isIsoDate, localToday } from './lib/dates.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'commands');

/**
 * A command is one file in `src/commands/` exporting these members.
 * @typedef {object} Command
 * @property {string} name
 * @property {string} summary one line, shown in `--help`
 * @property {string} usage argument synopsis, for example `<vault>`
 * @property {Record<string, { type: 'boolean' | 'string' }>} [options] extra flags beyond `--json`
 * @property {(ctx: CommandContext) => Promise<number> | number} run returns the exit code
 *
 * @typedef {object} CommandContext
 * @property {string[]} args positional arguments after the command name
 * @property {Record<string, any>} values parsed flags (`json` is always present)
 * @property {boolean} json whether to print the JSON report
 * @property {string} version framework version
 * @property {string} today current date as `YYYY-MM-DD`: the local date, or the global `--today` option
 * @property {(text: string) => void} print write to stdout
 */

/**
 * @param {Command[]} commands
 * @returns {string}
 */
function usageText(commands) {
  const width = Math.max(...commands.map((c) => `${c.name} ${c.usage}`.length));
  const rows = commands.map((c) => `  ${`${c.name} ${c.usage}`.padEnd(width)}  ${c.summary}`);
  return [
    'Usage: sbk <command> [arguments] [--json]',
    '',
    'Commands:',
    ...rows,
    '',
    'Options:',
    '  --json       print the JSON report instead of the human summary',
    '  --today D    treat D (YYYY-MM-DD) as the current date; default is the local date',
    '  --help       show this message',
    '  --version    show the framework version',
    '',
    'Exit codes: 0 no violations, 1 violations found, 2 usage or internal error.',
    '',
  ].join('\n');
}

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the program name
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const commands = /** @type {Command[]} */ (await loadModules(COMMANDS_DIR));
  const out = (/** @type {string} */ text) => process.stdout.write(text);
  const err = (/** @type {string} */ text) => process.stderr.write(text);
  try {
    const [first, ...rest] = argv;
    if (first === undefined) {
      throw new UsageError(`no command given\n\n${usageText(commands)}`);
    }
    if (first === '--help' || first === '-h') {
      out(usageText(commands));
      return 0;
    }
    if (first === '--version') {
      out(frameworkVersion() + '\n');
      return 0;
    }
    const command = commands.find((c) => c.name === first);
    if (!command) {
      throw new UsageError(`unknown command "${first}"\n\n${usageText(commands)}`);
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: { json: { type: 'boolean' }, help: { type: 'boolean' }, today: { type: 'string' }, ...command.options },
      });
    } catch (error) {
      throw new UsageError(/** @type {Error} */ (error).message);
    }
    const today = parsed.values.today ?? localToday();
    if (!isIsoDate(today)) throw new UsageError(`--today must be a date written YYYY-MM-DD, got "${today}"`);
    if (parsed.values.help) {
      out(`Usage: sbk ${command.name} ${command.usage} [--json]\n\n${command.summary}\n`);
      return 0;
    }
    return await command.run({
      args: parsed.positionals,
      values: parsed.values,
      json: parsed.values.json === true,
      version: frameworkVersion(),
      today,
      print: out,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}\n`);
      return 2;
    }
    err(`internal error: ${/** @type {Error} */ (error).stack ?? error}\n`);
    return 2;
  }
}

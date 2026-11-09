/**
 * Thrown for bad invocations or unusable input (unknown command, missing
 * argument, vault that does not exist, non-empty init target). The CLI maps it
 * to exit code 2 and prints the message to stderr.
 */
export class UsageError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] stable reason code, for a caller that tells refusals apart (`migrate-vault` does)
   */
  constructor(message, code) {
    super(message);
    this.name = 'UsageError';
    /** @type {string | undefined} */
    this.code = code;
  }
}

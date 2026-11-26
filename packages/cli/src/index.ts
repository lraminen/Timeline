/**
 * @chronicle/cli — programmatic entry point. `run(argv, io)` is what the
 * `chronicle` command executes; static export itself lives in @chronicle/static.
 */
export { run, embedUrlFor, VERSION, type Io } from './run.js';

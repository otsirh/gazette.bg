import path from 'node:path';
import { fileURLToPath } from 'node:url';

// True when the module was started with `node <file>` rather than imported,
// so a script can export its parts for tests and still run as a command.
export function isMain(importMetaUrl) {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

// One line per event, prefixed with the script's name; problems go to stderr.
export function createLogger(name) {
    return function log(message, level = 'INFO') {
        const line = `[${name}] ${level}: ${message}`;
        if (level === 'ERROR' || level === 'WARN') console.error(line);
        else console.log(line);
    };
}

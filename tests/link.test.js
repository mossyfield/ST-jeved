import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostStub } from './helpers/host.js';

const commands = hostStub().commands;

globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function modules(folder) {
    const found = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
            found.push(...await modules(path));
        } else if (entry.name.endsWith('.js')) {
            found.push(path);
        }
    }
    return found;
}

describe('every module loads', () => {
    it('imports the whole extension under a stubbed host', async () => {
        const files = [join(root, 'index.js'), ...await modules(join(root, 'src'))];
        assert.ok(files.length > 15, 'the sweep found the modules');
        for (const file of files) {
            const loaded = await import(pathToFileURL(file).href);
            assert.ok(loaded, `${relative(root, file)} loaded`);
        }
        assert.ok(commands.some(command => command.name === 'jeved'), '/jeved is registered');
    });
});

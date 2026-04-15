#!/usr/bin/env node
/* build-dataset-index.mjs — regenerate dataset/index.json.
 *
 * Walks dataset/ for *.7z files, derives a friendly name/description from
 * the filename, and writes a JSON manifest the viewer fetches on load to
 * render corpus cards on the landing screen.
 *
 * Run me after adding/removing a corpus file:
 *     node scripts/build-dataset-index.mjs
 *
 * The JSON format is intentionally tiny — the viewer can always open the
 * .7z to discover its true game count and manifest details. The fields
 * here just drive the landing-screen card UI.
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = resolve(HERE, '..', 'dataset');
const INDEX_PATH  = join(DATASET_DIR, 'index.json');

/** Parse our naming convention into a display-friendly label + tags.
 *  Recognized forms (loose):
 *    sweep_chain_<source>_<handle>_<date>_N<count>.7z
 *    single_<kind>_<date>_<source>_<detail>.7z
 *    <anything>.7z   → fallback to pretty-printed basename
 */
function describe(filename) {
  const base = filename.replace(/\.7z$/i, '');
  const parts = base.split('_');

  // sweep_chain_lichess_drnykterstein_2026-04-14_N10
  if (parts[0] === 'sweep' && parts[1] === 'chain') {
    const source = parts[2];
    const handle = parts[3];
    const date   = parts[4];
    const count  = /^N(\d+)/.exec(parts[5] || '')?.[1];
    return {
      title: `${handle} chain`,
      subtitle: [source, date, count && `${count} games`].filter(Boolean).join(' · '),
      tags: ['chain', source, handle].filter(Boolean),
    };
  }

  // single_lichess_pgn_2026.04.15_lichess_AI_level_1_vs_lemonforest.eo9BSVgI
  if (parts[0] === 'single') {
    const restBase = parts.slice(1).join('_');
    const cleaned = restBase.replace(/\.[a-zA-Z0-9]{6,}$/, ''); // strip trailing hash
    return {
      title: 'Single game',
      subtitle: cleaned.replace(/_/g, ' '),
      tags: ['single'],
    };
  }

  return {
    title: base.replace(/_/g, ' '),
    subtitle: '',
    tags: [],
  };
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

async function main() {
  let entries;
  try {
    entries = await readdir(DATASET_DIR);
  } catch (e) {
    console.error(`dataset/ not found at ${DATASET_DIR}: ${e.message}`);
    process.exit(1);
  }
  const files = entries.filter((f) => /\.7z$/i.test(f)).sort();

  const corpora = [];
  for (const f of files) {
    const full = join(DATASET_DIR, f);
    const st = await stat(full);
    const d = describe(f);
    corpora.push({
      file: f,
      size: st.size,
      size_human: formatBytes(st.size),
      mtime: new Date(st.mtimeMs).toISOString(),
      title: d.title,
      subtitle: d.subtitle,
      tags: d.tags,
    });
  }

  const out = {
    generated_at: new Date().toISOString(),
    count: corpora.length,
    corpora,
  };
  await writeFile(INDEX_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`wrote ${INDEX_PATH} (${corpora.length} corpus${corpora.length === 1 ? '' : 'es'})`);
  for (const c of corpora) console.log(`  · ${c.file}  ${c.size_human}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

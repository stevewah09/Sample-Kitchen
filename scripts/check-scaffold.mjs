import { readFile } from 'node:fs/promises';

const requiredFiles = [
  'public/index.html',
  'api/health.js',
  'schema.sql',
  'reference-data/scenario.json',
  'reference-data/products_and_recipes.json',
  'reference-data/supplier.json',
];

for (const file of requiredFiles) {
  await readFile(file);
  process.stdout.write(`PASS ${file} exists\n`);
}

for (const file of requiredFiles.filter((path) => path.endsWith('.json'))) {
  JSON.parse(await readFile(file, 'utf8'));
  process.stdout.write(`PASS ${file} parses as JSON\n`);
}

const ignore = await readFile('.gitignore', 'utf8');
if (!ignore.split(/\r?\n/).includes('operating-data/')) {
  throw new Error('operating-data/ must be excluded from Git');
}
process.stdout.write('PASS operating-data/ is excluded from Git\n');

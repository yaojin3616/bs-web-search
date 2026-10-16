import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']

export async function packPlugin(outputRoot = join(project, '.build')) {
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  const files = {}, inventories = {}
  for (const target of targets) {
    const inventory = {}
    for (const file of ['package.json', ...pkg.files]) {
      const bytes = await readFile(join(project, file))
      const path = `node_modules/${pkg.name}/${file}`
      files[`bundles/${target}/${path}`] = bytes
      inventory[path] = createHash('sha256').update(bytes).digest('hex')
    }
    inventories[target] = inventory
  }
  const manifest = {
    schema_version: 1,
    plugin: {
      name: pkg.name, version: pkg.version, display_name: 'Codex Search',
      description: pkg.description, publisher: 'yaojin3616', license: pkg.license,
      desktop_min: '1.0.1', permissions: ['network'], services: ['web', 'enterpriseSearch']
    },
    targets: inventories
  }
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2))
  const bytes = zipSync(files, { level: 9, mtime: new Date('2020-01-01T00:00:00Z') })
  await mkdir(outputRoot, { recursive: true })
  const artifact = join(outputRoot, `${pkg.name}-${pkg.version}.zip`)
  await writeFile(artifact, bytes)
  return artifact
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await packPlugin()}\n`)
}

#!/usr/bin/env node
/* global console */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep OCR runtime and license files beside the app, so recognition never falls back to a CDN.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(root, 'public')
const ocrDir = path.join(publicDir, 'map-ocr')
const coreDir = path.join(root, 'node_modules', 'tesseract.js-core')
const files = [
  [path.join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'), path.join(ocrDir, 'worker.min.js')],
  ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap(variant => [
    ['wasm.js', 'wasm'].map(ext => [
      path.join(coreDir, `tesseract-core-${variant}.${ext}`),
      path.join(ocrDir, `tesseract-core-${variant}.${ext}`),
    ]),
  ]).flat(),
  [path.join(root, 'LICENSE'), path.join(publicDir, 'LICENSE')],
  [path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(publicDir, 'THIRD-PARTY-NOTICES.md')],
  ...fs.readdirSync(path.join(root, 'third-party-licenses')).map(name => [
    path.join(root, 'third-party-licenses', name),
    path.join(publicDir, 'third-party-licenses', name),
  ]),
]

for (const [source, target] of files) {
  if (!fs.existsSync(source)) throw new Error(`地图 OCR 打包资源缺失：${path.relative(root, source)}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target) && fs.statSync(source).size === fs.statSync(target).size
    && fs.readFileSync(source).equals(fs.readFileSync(target))) continue
  fs.copyFileSync(source, target)
}
for (const language of ['chi_sim', 'eng']) {
  if (!fs.existsSync(path.join(ocrDir, `${language}.traineddata`))) {
    throw new Error(`地图 OCR 语言数据缺失：public/map-ocr/${language}.traineddata`)
  }
}
console.log('[map-ocr] 已备齐本地 worker、WASM、语言数据和版权文件')

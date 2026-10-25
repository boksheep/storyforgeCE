/* global console */

/**
 * WEB-DEPLOY-1 · 可选 AI 反向代理配置生成器。
 *
 * ## 为什么是「生成」而不是手写几份示例
 *
 * 代理路由的单一事实源是 `src/lib/ai/proxy-routes.json`（开发服务器与桌面版共用）。
 * 网页云端版一旦手写一份 Vercel / Netlify / nginx 的代理表，就等于复制了第三份
 * 路由清单——将来新增服务商时必然漂移，而漂移的表现是「设置里那个按钮指向 404」。
 *
 * 因此这里从同一份 JSON 派生各平台配置，并由 `scripts/package-web.mjs` 断言
 * 「每一条路由都出现在每份产物里」，缺一条就构建失败。
 *
 * 默认**不启用**：生成物只放进发布包的 `proxy-examples/`，由部署者自行决定是否
 * 把域名变成上游 API 的转发入口（见 proxy-examples/README.md 的风险说明）。
 */

/** 与 src/lib/ai/proxy-routes.json 的 Route 结构一致。 */
function normalize(routes) {
  return routes.map((route) => ({
    prefix: route.prefix,
    target: route.target.replace(/\/+$/, ''),
    rewriteTo: (route.rewriteTo ?? '').replace(/\/+$/, ''),
    host: new URL(route.target).host,
    destinationBase: `${route.target.replace(/\/+$/, '')}${(route.rewriteTo ?? '').replace(/\/+$/, '')}`,
  }))
}

const HEADER = [
  '本文件由 scripts/package-web.mjs 从 src/lib/ai/proxy-routes.json 生成，请勿手改；',
  '要改路由请改那一份 JSON，然后重新执行 npm run package:web。',
  '',
  '⚠️ 启用后你的域名会成为这些上游 API 的转发入口：任何拿到该地址的人都能借用你的',
  '   带宽与配额（API Key 仍由调用方自带，不会泄露你的 Key）。不理解这句话就不要启用。',
].join('\n')

/** Vercel：一份可直接替换根目录 vercel.json 的完整配置。 */
export function buildVercelProxyConfig(routes) {
  const list = normalize(routes)
  return {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    rewrites: [
      ...list.map(route => ({
        source: `${route.prefix}/:path*`,
        destination: `${route.destinationBase}/:path*`,
      })),
      // SPA 回退必须排在代理之后
      { source: '/((?!assets/).*)', destination: '/index.html' },
    ],
    headers: [
      {
        source: '/assets/(.*)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
      {
        source: '/index.html',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ],
  }
}

/** Netlify / Cloudflare Pages：把规则**追加到现有 `_redirects` 的最前面**（在 SPA 回退之前）。 */
export function buildRedirectsProxyRules(routes) {
  const list = normalize(routes)
  const lines = [
    `# ${HEADER.split('\n')[0]}`,
    '#',
    ...HEADER.split('\n').slice(1).map(line => (line ? `# ${line}` : '#')),
    '#',
    '# 用法：把这些规则复制到 _redirects 的**最上方**（必须在 /* /index.html 200 之前）。',
    '',
  ]
  for (const route of list) {
    lines.push(`${route.prefix}/*  ${route.destinationBase}/:splat  200`)
  }
  return `${lines.join('\n')}\n`
}

/** nginx：一组 location 块，粘进 server {} 内即可。 */
export function buildNginxProxyLocations(routes) {
  const list = normalize(routes)
  const chunks = [
    '# ' + HEADER.split('\n')[0],
    '#',
    ...HEADER.split('\n').slice(1).map(line => (line ? `# ${line}` : '#')),
    '#',
    '# 用法：把下面每个 location 块复制进 nginx.conf 的 server { ... } 内。',
    '# proxy_buffering off 是流式（SSE）输出必需的，删掉会导致生成过程整段卡住后一次性吐出。',
    '',
  ]
  for (const route of list) {
    chunks.push(
      `# ${route.prefix}/  →  ${route.destinationBase}/`,
      `location ${route.prefix}/ {`,
      `    proxy_pass ${route.destinationBase}/;`,
      '    proxy_http_version 1.1;',
      '    proxy_ssl_server_name on;',
      `    proxy_set_header Host ${route.host};`,
      "    proxy_set_header Connection '';",
      '    proxy_buffering off;',
      '    proxy_cache off;',
      '    proxy_read_timeout 600s;',
      '    proxy_send_timeout 600s;',
      '}',
      '',
    )
  }
  return chunks.join('\n')
}

/**
 * 自检：每份产物都必须覆盖 proxy-routes.json 里的**全部**前缀。
 * 返回缺失清单（空数组 = 通过）。
 */
export function verifyProxyCoverage(routes, artifacts) {
  const missing = []
  for (const route of routes) {
    for (const [name, text] of Object.entries(artifacts)) {
      if (!text.includes(route.prefix)) missing.push(`${name} 缺少路由 ${route.prefix}`)
    }
  }
  return missing
}

// ESLint 扁平配置(AUDIT-3 · §11.5 决策③)
//
// 策略:规则严重度仍按风险分 error/warn/off,但 npm script 使用 --max-warnings=0，
// 当前零 warning 基线进入 CI；新增 warning 也会阻断，防止观察期债务回潮。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      'dist', 'dev-dist', 'coverage', 'node_modules',
      // WEB-DEPLOY-1：网页云端版把构建产物放到独立目录，发布包放到 release/。
      // 这些都是压缩后的机器产物，对它们跑 lint 只会产出上万条无意义报错，
      // 并且会把真正的源码问题淹没。**新增任何构建产物目录都要登记在这里。**
      'dist-web', 'release',
      // 构建临时目录（.gitignore 同样覆盖）：不登记的话，一次构建失败留下的
      // 中间产物就会让 lint 持续报错，而报错内容和源码毫无关系。
      '.tmp-build',
      '**/*.config.{js,ts,mjs,cjs}', 'scripts/**', 'public/**',
      // Electron 桌面版是独立 Node 工作区：自带 node_modules/release，
      // 且是 Node 侧代码（用 process 等全局，与前端规则集不匹配）。
      // 它的正确性由 desktop/verify-server.mjs（目录穿越 / SPA 回退 / 代理路由）
      // 与真实构建启动来验证，不并入前端的 --max-warnings=0 门禁。
      'desktop/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        console: 'readonly', fetch: 'readonly', localStorage: 'readonly',
        sessionStorage: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', Blob: 'readonly',
        URL: 'readonly', crypto: 'readonly', indexedDB: 'readonly',
      },
    },
    rules: {
      // ── 高价值:保持 error ──
      'react-hooks/rules-of-hooks': 'error',

      // ── 观察期降噪(项目现状,先 warn / off,后续收紧)──
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off', // 纯前端 Dexie/动态结构大量 as any,本就需要
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      'no-empty': 'warn',
      'no-constant-condition': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-control-regex': 'off',
      'no-irregular-whitespace': 'warn', // 中文项目偶有全角空格,观察期 warn
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
  {
    // ── LOG-1:生产代码里禁止裸 console(可测量门槛)──
    // console 输出既不落盘、也不带级别/tag,排查问题时要靠人肉回忆"当时控制台刷了什么"。
    // 统一走 lib/logging 的 log.*（写内存环形 + 按天 txt）。
    //
    // 只约束 src/**:测试用 console 打印调试信息是正当的（且 tests 有自己的输出惯例）；
    // scripts/** 与 desktop/** 已在全局 ignores 里（Node 侧脚本靠 stdout 报告结果）。
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-console': 'error' },
  },
  {
    // 日志系统自身必须能用 console 兜底（写日志前/写日志失败时），
    // 且它的输出是"给开发者的最后一道防线"，不参与自身的 txt 管道。
    files: ['src/lib/logging/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
)

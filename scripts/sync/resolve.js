#!/usr/bin/env node
/**
 * 自动解决「master -> 变体分支」合并冲突。
 *
 * 只处理已知的、确定性的冲突；遇到任何未预期的冲突一律以非 0 退出，
 * 由工作流跳过该分支，不做猜测性修改。
 *
 * 用法: node scripts/resolve-branch-sync.js <branch>
 * 依赖: 当前工作区处于一次未完成的 merge 中（git merge --no-commit 后）
 */
const fs = require('fs')
const { execFileSync } = require('child_process')

const BRANCH_META = {
  xiaomi: { workflow: 'Xiaomi', title: '小米后屏版' },
  kugou: { workflow: 'Kugou', title: '酷狗音乐版' },
  kuwo: { workflow: 'Kuwo', title: '酷我音乐机车/TV版' },
  netease: { workflow: 'Netease', title: '网易云音乐版' },
  qqmusic: { workflow: 'QQmusic', title: 'QQ音乐版' },
}

const branch = process.argv[2]
if (!BRANCH_META[branch]) {
  console.error(`未知分支: ${branch}`)
  process.exit(1)
}
const meta = BRANCH_META[branch]
const suffix = `-${branch}`

/** 各分支的 APP_PROVIDER_NAME（与 android applicationId 保持一致） */
const PROVIDER = {
  xiaomi: 'com.luna.music.provider',
  kugou: 'com.kugou.android.provider',
  kuwo: 'cn.kuwo.music.tv.provider',
  netease: 'com.netease.cloudmusic.provider',
  qqmusic: 'com.tencent.qqmusic.provider',
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const write = (p, s) => fs.writeFileSync(p, s, 'utf8')
const eol = (s) => (s.includes('\r\n') ? '\r\n' : '\n')

const unmerged = () => git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)

/**
 * 冲突各侧的原始内容快照。
 * 必须在任何 git add 之前一次性读取 —— 冲突被 add 之后 stage 2/3 会消失，
 * 之后再取就只能拿到已写入的工作区内容。
 */
const SNAP = { ours: {}, theirs: {} }

function snapshot(files) {
  for (const f of files) {
    for (const [key, stage] of [['ours', 2], ['theirs', 3]]) {
      try {
        SNAP[key][f] = execFileSync('git', ['show', `:${stage}:${f}`], {
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        SNAP[key][f] = null
      }
    }
  }
}

/**
 * 取某一侧的文件内容。
 * - 冲突文件：优先用 snapshot 快照
 * - 无冲突文件：ours 取工作区，theirs 直接取 origin/master
 */
const side = (file, which) => {
  // 2 = ours(分支) 3 = theirs(master)
  const key = which === 3 || which === '3' ? 'theirs' : 'ours'
  const v = SNAP[key][file]
  if (v != null) return v

  if (key === 'theirs') {
    try {
      return execFileSync('git', ['show', `origin/master:${file}`], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      return fs.readFileSync(file, 'utf8')
    }
  }
  return fs.readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------- 各文件处理

/** package.json：版本号取 master（分支版本 = 上游版本 + 后缀，package.json 与上游一致） */
function resolvePackageJson(file) {
  write(file, side(file, 3))
}

/** publish/version.json：版本取 package.json（master 的 version.json 可能滞后），内容取 master */
function resolveVersionJson(file) {
  const master = JSON.parse(side(file, 3))
  const ours = JSON.parse(side(file, 2))
  // 以 package.json 的版本为准：publish/version.json 依赖 publish 脚本刷新，可能落后
  const baseVer = JSON.parse(side('package.json', 3)).version

  // 分支上一次发布的版本要进 history，便于老用户看到更新日志
  const history = [...(master.history || [])]
  const prevBranchVersion = `${baseVer}${suffix}`
  if (!history.some((h) => h.version === prevBranchVersion)) {
    // 若分支当前版本低于 master，说明分支自身也发过版，保留其记录
    const oursVersion = ours.version
    if (oursVersion && oursVersion !== prevBranchVersion && !history.some((h) => h.version === oursVersion)) {
      history.unshift({ version: oursVersion, desc: ours.desc || '' })
    }
  }

  const out = { version: `${baseVer}${suffix}`, desc: master.desc || '', history }
  write(file, JSON.stringify(out) + '\n')
}

/**
 * src/utils/version.js：保留分支定制（更新源分支 + 带后缀的资产名），
 * 其余内容取 master 的最新实现。
 */
function resolveVersionJs(file) {
  const master = side(file, 3)
  const nl = eol(master)
  let s = master

  // 1) import 增加 APP_VERSION_SUFFIX
  s = s.replace(
    "import { APP_PROVIDER_NAME } from '@/config/constant'",
    "import { APP_PROVIDER_NAME, APP_VERSION_SUFFIX } from '@/config/constant'",
  )
  if (!s.includes('APP_VERSION_SUFFIX')) {
    throw new Error('version.js: 未找到 APP_PROVIDER_NAME 的 import 行，上游结构可能已变')
  }

  // 2) 在 PACKAGE_NAME 之后插入分支常量
  const pkgLine = 'const PACKAGE_NAME = name'
  if (!s.includes(pkgLine)) throw new Error('version.js: 未找到 PACKAGE_NAME 定义')
  s = s.replace(pkgLine, `${pkgLine}${nl}const FORK_UPDATE_BRANCH = '${branch}'`)

  // 3) 更新源指向本分支
  const addrStart = s.indexOf('const address = [')
  if (addrStart < 0) throw new Error('version.js: 未找到 address 数组')
  // 从 '[' 起做括号配对，跳过模板字符串内容，找到数组真正的结尾
  let depth = 0
  let addrEnd = -1
  let inTemplate = false
  for (let i = s.indexOf('[', addrStart); i < s.length; i++) {
    const ch = s[i]
    if (inTemplate) {
      if (ch === '`') inTemplate = false
      continue
    }
    if (ch === '`') { inTemplate = true; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) { addrEnd = i; break }
    }
  }
  if (addrEnd < 0) throw new Error('version.js: address 数组未闭合')
  const B = '`'
  // eslint-disable-next-line no-template-curly-in-string
  const raw = 'https://raw.githubusercontent.com/${FORK_OWNER}/${FORK_REPO}/${FORK_UPDATE_BRANCH}/publish/version.json'
  // eslint-disable-next-line no-template-curly-in-string
  const jsdPath = '/gh/${FORK_OWNER}/${FORK_REPO}@${FORK_UPDATE_BRANCH}/publish/version.json'
  const newAddress = [
    'const address = [',
    '  [' + B + raw + B + ", 'direct'],",
    '  [' + B + 'https://cdn.jsdelivr.net' + jsdPath + B + ", 'direct'],",
    '  [' + B + 'https://fastly.jsdelivr.net' + jsdPath + B + ", 'direct'],",
    '  [' + B + 'https://gcore.jsdelivr.net' + jsdPath + B + ", 'direct'],",
    ']',
  ].join(nl)
  // addrEnd 处的 ']' 后面可能紧跟 ','（master 版本无，保险起见跳过）
  let after = addrEnd + 1
  if (s[after] === ',') after++
  s = s.slice(0, addrStart) + newAddress + s.slice(after)

  // 4) 下载地址：从带后缀版本号拆出基础版本，后缀拼到 ABI 之后
  const urlRe = /(\n[ \t]*)(\/\/[^\n]*\n[ \t]*)*const url = `https:\/\/github\.com\/\$\{FORK_OWNER\}\/\$\{FORK_REPO\}\/releases\/download\/v\$\{version\}\/\$\{PACKAGE_NAME\}-v\$\{version\}-\$\{abi\}\.apk`/
  if (!urlRe.test(s)) throw new Error('version.js: 未找到下载 URL 定义，上游结构可能已变')
  const baseVersion = JSON.parse(side('package.json', 3)).version
  s = s.replace(urlRe, (_m, indent) => {
    const pad = indent.replace(/^[\r\n]+/, '') || '  '
    return [
      '',
      `${pad}// version 为分支发布版本号（如 ${baseVersion}${suffix}），Release tag 即 v\${version}；`,
      `${pad}// 但构建产物的 APK 名是 {name}-v{基础版本}-{abi}${suffix}.apk（后缀在 ABI 之后），`,
      `${pad}// 因此需要把版本号里的分支后缀拆出来，拼到 ABI 之后`,
      `${pad}const assetVersion = version.replace(APP_VERSION_SUFFIX, '')`,
      `${pad}const url = \`https://github.com/\${FORK_OWNER}/\${FORK_REPO}/releases/download/v\${version}/\${PACKAGE_NAME}-v\${assetVersion}-\${abi}\${APP_VERSION_SUFFIX}.apk\``,
    ].join(nl)
  })

  write(file, s)
}

/** README.md：保留分支徽章与分支说明，其余取 master */
function resolveReadme(file) {
  const master = side(file, 3)
  const nl = eol(master)
  let s = master

  // 版本号取自 master 的 package.json，用于徽章链接与分支说明
  const baseVersion = JSON.parse(side('package.json', 3)).version

  const releaseBadge =
    `  <a href="https://github.com/app-pop/lxmusic/releases/tag/v${baseVersion}${suffix}">` +
    `<img src="https://img.shields.io/github/v/release/app-pop/lxmusic?filter=v*-${branch}&amp;label=release" alt="Release version"></a>`
  const buildBadge =
    `  <a href="https://github.com/app-pop/lxmusic/actions/workflows/release-${branch}.yml">` +
    `<img src="https://github.com/app-pop/lxmusic/workflows/Build%20(${meta.workflow})/badge.svg" alt="Build status"></a>`

  // 替换 master 的 release 徽章
  const relRe = /^[ \t]*<a href="https:\/\/github\.com\/app-pop\/lxmusic\/releases"><img src="https:\/\/img\.shields\.io\/github\/release\/app-pop\/lxmusic"[^>]*><\/a>[ \t]*$/m
  if (!relRe.test(s)) throw new Error('README: 未找到 master release 徽章行')
  s = s.replace(relRe, releaseBadge)

  // 替换 master 的 Build 徽章
  const buildRe = /^[ \t]*<a href="https:\/\/github\.com\/app-pop\/lxmusic\/actions\/workflows\/release\.yml"><img src="https:\/\/github\.com\/app-pop\/lxmusic\/workflows\/Build\/badge\.svg"[^>]*><\/a>[ \t]*$/m
  if (!buildRe.test(s)) throw new Error('README: 未找到 master Build 徽章行')
  s = s.replace(buildRe, buildBadge)

  // 删除 beta-pack 徽章（变体分支没有该工作流）
  const betaRe = /^[ \t]*<a href="https:\/\/github\.com\/app-pop\/lxmusic\/actions\/workflows\/beta-pack\.yml">[^\n]*<\/a>[ \t]*\r?\n/m
  s = s.replace(betaRe, '')

  // 插入分支说明
  const anchor = '## 关于本仓库（app-pop / [lxmusic](https://github.com/app-pop/lxmusic)）'
  if (!s.includes(anchor)) throw new Error('README: 未找到「关于本仓库」标题')
  const B2 = '`'
  const note =
    anchor + nl + nl +
    '当前分支：**' + B2 + branch + B2 + '（' + meta.title + '）**。版本号形如 ' + B2 + baseVersion + suffix + B2 +
    '，可与 master 主线共存安装；更新检查只读取本分支的 ' + B2 + 'publish/version.json' + B2 + '，不会串到其他版本。'
  s = s.replace(anchor, note)

  write(file, s)
}

/**
 * src/config/constant.ts：取 master 版本，再套回分支定制
 * （APP_PROVIDER_NAME 与 APP_VERSION_SUFFIX）。上游改动其他常量时能自动合入。
 */
function resolveConstant(file) {
  const master = side(file, 3)
  const nl = eol(master)
  let s = master

  // provider 包名
  const providerRe = /export const APP_PROVIDER_NAME = '[^']*'/
  if (!providerRe.test(s)) throw new Error('constant.ts: 未找到 APP_PROVIDER_NAME')
  s = s.replace(providerRe, `export const APP_PROVIDER_NAME = '${PROVIDER[branch]}'`)

  // 版本后缀块：先删除所有已存在的块（master 空串块 + 分支块），再统一插入一份
  const suffixBlockRe = /(?:\r?\n)*\/\/ fork：分支版本号后缀。[\s\S]*?export const APP_VERSION = `\$\{version\}\$\{APP_VERSION_SUFFIX\}`(?:\r?\n)*/g
  s = s.replace(suffixBlockRe, nl)

  const suffixBlock = [
    '',
    '// fork：分支版本号后缀。package.json 的 version 始终与上游同步，',
    `// 分支自身的发布版本号由「上游版本 + 后缀」组成（如 1.9.3${suffix}），`,
    '// 用于检查各自分支的更新；master 分支该常量为空字符串',
    `export const APP_VERSION_SUFFIX = '${suffix}'`,
    // eslint-disable-next-line no-template-curly-in-string
    'export const APP_VERSION = `${version}${APP_VERSION_SUFFIX}`',
    '',
  ].join(nl)

  const anchor = `export const APP_PROVIDER_NAME = '${PROVIDER[branch]}'`
  if (!s.includes(anchor)) throw new Error('constant.ts: 插入版本后缀块失败')
  s = s.replace(anchor, anchor + nl + suffixBlock)

  // 确保 version 已 import
  if (!s.includes("from '../../package.json'")) {
    s = "import { version } from '../../package.json'" + nl + nl + s
  }

  write(file, s)
}

const HANDLERS = {
  'package.json': resolvePackageJson,
  'publish/version.json': resolveVersionJson,
  'src/utils/version.js': resolveVersionJs,
  'src/config/constant.ts': resolveConstant,
  'README.md': resolveReadme,
}

/** 变体分支只保留自己的 release 工作流，master 专属工作流一律删除 */
const MASTER_ONLY_WORKFLOWS = [
  'release.yml',
  'sync-upstream.yml',
  'sync-master-to-xiaomi.yml',
  'sync-master-to-branches.yml',
]

function pruneMasterWorkflows() {
  for (const wf of MASTER_ONLY_WORKFLOWS) {
    const p = `.github/workflows/${wf}`
    if (fs.existsSync(p)) {
      git('rm', '-q', '-f', p)
      console.log(`移除 master 专属工作流: ${wf}`)
    }
  }
}

/**
 * 合并完成后的统一归一化。
 * 即便某些文件没有冲突（git 自动合并成功），master 的定制也可能与分支定制
 * 在无冲突位置叠加（典型：constant.ts 出现两份 APP_VERSION_SUFFIX），
 * 因此这里对所有定制文件强制重跑一次处理器。
 */
function normalizeAfterMerge() {
  const targets = ['package.json', 'publish/version.json', 'src/utils/version.js', 'src/config/constant.ts', 'README.md']
  for (const f of targets) {
    if (!fs.existsSync(f)) continue
    // 该文件若仍处于冲突状态，跳过（已由冲突处理分支负责）
    const staged = git('diff', '--name-only', '--diff-filter=U', '--', f).trim()
    if (staged) continue
    try {
      HANDLERS[f](f)
      git('add', f)
    } catch (err) {
      console.error(`归一化 ${f} 失败: ${err.message}`)
      process.exit(4)
    }
  }
  pruneMasterWorkflows()
}

// ------------------------------------------------------------------- 主流程

function main() {
  const files = unmerged()

  if (files.length === 0) {
    // 无冲突时也需要归一化：master 的改动可能与分支定制在无冲突位置并存，
    // 例如 constant.ts 里重复的 APP_VERSION_SUFFIX 定义。
    console.log('无冲突文件，执行归一化检查')
    normalizeAfterMerge()
    return
  }

  const unknown = files.filter((f) => !HANDLERS[f])
  if (unknown.length > 0) {
    console.error(`存在未预期冲突文件，放弃自动解决:\n  ${unknown.join('\n  ')}`)
    process.exit(2)
  }

  // 在任何 git add 之前快照两侧内容
  snapshot(files)

  for (const f of files) {
    console.log(`解决冲突: ${f}`)
    HANDLERS[f](f)
    git('add', f)
  }

  normalizeAfterMerge()

  // 兜底：确认没有遗留冲突标记
  let left = ''
  try {
    left = git('grep', '-l', '-E', '^(<<<<<<< |=======$|>>>>>>> )', '--', '.', ':!package-lock.json').trim()
  } catch {
    // git grep 无匹配时退出码为 1
  }
  if (left) {
    console.error(`仍有冲突标记:\n${left}`)
    process.exit(3)
  }

  console.log('全部冲突已解决')
}

main()

#!/usr/bin/env node
/**
 * 校验「master -> 变体分支」合并结果是否保留了分支定制。
 *
 * 任何一项不通过都以非 0 退出，由工作流跳过该分支。
 *
 * 用法: node scripts/verify-branch-sync.js <branch>
 */
const fs = require('fs')
const { execFileSync } = require('child_process')

const EXPECT = {
  xiaomi: { provider: 'com.luna.music.provider', pkg: 'com.luna.music', workflow: 'release-xiaomi.yml' },
  kugou: { provider: 'com.kugou.android.provider', pkg: 'com.kugou.android', workflow: 'release-kugou.yml' },
  kuwo: { provider: 'cn.kuwo.music.tv.provider', pkg: 'cn.kuwo.music.tv', workflow: 'release-kuwo.yml' },
  netease: { provider: 'com.netease.cloudmusic.provider', pkg: 'com.netease.cloudmusic', workflow: 'release-netease.yml' },
  qqmusic: { provider: 'com.tencent.qqmusic.provider', pkg: 'com.tencent.qqmusic', workflow: 'release-qqmusic.yml' },
}

const branch = process.argv[2]
if (!EXPECT[branch]) {
  console.error(`未知分支: ${branch}`)
  process.exit(1)
}
const expect = EXPECT[branch]
const suffix = `-${branch}`

const read = (p) => fs.readFileSync(p, 'utf8')
const errors = []
const check = (cond, msg) => { if (!cond) errors.push(msg) }

// 1. constant.ts：provider 与版本后缀
const constant = read('src/config/constant.ts')
check(
  constant.includes(`export const APP_PROVIDER_NAME = '${expect.provider}'`),
  `APP_PROVIDER_NAME 应为 ${expect.provider}`,
)
check(
  constant.includes(`export const APP_VERSION_SUFFIX = '${suffix}'`),
  `APP_VERSION_SUFFIX 应为 ${suffix}`,
)
check(constant.includes('export const APP_VERSION ='), '缺少 APP_VERSION 定义')

// 2. version.js：更新源分支 + 带后缀资产名
const versionJs = read('src/utils/version.js')
check(versionJs.includes(`const FORK_UPDATE_BRANCH = '${branch}'`), `FORK_UPDATE_BRANCH 应为 ${branch}`)
check(versionJs.includes("const FORK_REPO = 'lxmusic'"), 'FORK_REPO 应为 lxmusic')
check(versionJs.includes('const assetVersion = version.replace(APP_VERSION_SUFFIX, '), '缺少 assetVersion 拆分逻辑')
// eslint-disable-next-line no-template-curly-in-string
check(versionJs.includes('${APP_VERSION_SUFFIX}.apk'), '下载 URL 未拼接分支后缀')

// 2b. address 数组必须完整且每项都指向本分支（防止合并残留旧地址）
const addrMatch = versionJs.match(/const address = \[[\s\S]*?\n\]/)
check(!!addrMatch, '未找到 address 数组')
if (addrMatch) {
  const entries = addrMatch[0].match(/https:\/\/[^`]+/g) || []
  check(entries.length === 4, `address 数组应有 4 个地址，实际 ${entries.length}`)
  // eslint-disable-next-line no-template-curly-in-string
  check(entries.every((u) => u.includes('${FORK_UPDATE_BRANCH}')), 'address 中存在未指向本分支的地址')
}
// 数组闭合后不应残留多余项
check(!/const address = \[[\s\S]*?\n\],/.test(versionJs), 'address 数组结构异常（存在残留项）')

// 3. package.json：版本与 master 一致（不含后缀）
const pkg = JSON.parse(read('package.json'))
check(!pkg.version.includes('-'), `package.json version 不应带后缀，当前为 ${pkg.version}`)

// 4. publish/version.json：版本带分支后缀
const verJson = JSON.parse(read('publish/version.json'))
check(
  verJson.version === `${pkg.version}${suffix}`,
  `publish/version.json 版本应为 ${pkg.version}${suffix}，当前为 ${verJson.version}`,
)

// 5. README：分支徽章存在，beta-pack 徽章已移除
const readme = read('README.md')
check(readme.includes(`filter=v*-${branch}`), 'README 缺少分支 Release 徽章')
check(readme.includes(`workflows/release-${branch}.yml`), 'README 缺少分支 Build 徽章')
check(!readme.includes('workflows/beta-pack.yml'), 'README 仍含 beta-pack 徽章（分支无该工作流）')
check(readme.includes(`当前分支：**\`${branch}\`**`) || readme.includes(`当前分支：**\`${branch}\`（`), 'README 缺少分支说明')

// 6. 原生包名：build.gradle 的 namespace/applicationId
const gradle = read('android/app/build.gradle')
check(
  gradle.includes(`applicationId "${expect.pkg}"`),
  `applicationId 应为 ${expect.pkg}`,
)
check(gradle.includes(`namespace "${expect.pkg}"`), `namespace 应为 ${expect.pkg}`)

// 7. 分支专属工作流仍在
check(fs.existsSync(`.github/workflows/${expect.workflow}`), `缺少工作流 ${expect.workflow}`)

// 8. 没有遗留冲突标记
let markers = ''
try {
  markers = execFileSync('git', ['grep', '-l', '-E', '^(<<<<<<< |=======$|>>>>>>> )', '--', '.', ':!package-lock.json'], { encoding: 'utf8' }).trim()
} catch { /* grep 无匹配时退出码为 1 */ }
check(!markers, `存在冲突标记: ${markers}`)

// 9. 变体分支不应包含 master 专属工作流（保持分支精简）
for (const wf of ['release.yml', 'sync-upstream.yml', 'sync-master-to-xiaomi.yml', 'sync-master-to-branches.yml']) {
  check(!fs.existsSync(`.github/workflows/${wf}`), `分支不应包含 master 工作流 ${wf}`)
}

if (errors.length > 0) {
  console.error(`校验失败 (${branch}):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`校验通过 (${branch})`)

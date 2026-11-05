/**
 * 生成 `Resources/node-source.env`:安装器第零段(stage0.sh)去哪儿下 node、下完对哪个 sha256。
 *
 * **为什么要生成而不是抄一份**:版本号与校验和的真相源是
 * `workbench-plugin/src/server/setup/paths.ts`(那里有注释说明为什么锁这一版、
 * 为什么校验和钉在仓库里)。抄一份到 shell 脚本里,换版本时必然有一天忘了改另一处 ——
 * 而那一处一错,要么下不下来,要么下了个对不上的包。生成就不可能不一致。
 *
 *     node deploy/installer/node-source-env.ts > <Resources>/node-source.env
 */
import {
  LOCKED_NODE_VERSION, MIN_NODE_MAJOR, NODE_TARBALL_NAME, NODE_TARBALL_SHA256, NODE_TARBALL_URLS,
} from '../../workbench-plugin/src/server/setup/paths.ts'

const lines = [
  '# 由 deploy/installer/node-source-env.ts 从 setup/paths.ts 生成。别手改。',
  `NODE_VERSION=${LOCKED_NODE_VERSION}`,
  `NODE_TARBALL_NAME=${NODE_TARBALL_NAME}`,
  `NODE_SHA256=${NODE_TARBALL_SHA256}`,
  `MIN_NODE_MAJOR=${MIN_NODE_MAJOR}`,
  // 空格分隔,stage0.sh 里 `for URL in $NODE_URLS` 直接用。国内镜像在前、官方在后。
  `NODE_URLS="${NODE_TARBALL_URLS.join(' ')}"`,
  '',
]
process.stdout.write(lines.join('\n'))

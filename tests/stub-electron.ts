/**
 * 测试用 electron 桩：脱离 GUI 跑 organizer / manifest 的逻辑。
 * 只在 tests 的打包入口里被 alias 替换，不参与正式构建。
 */
import { tmpdir } from 'os'
import { join } from 'path'

const userData = join(tmpdir(), 'picturemanager-test-userdata')

export const app = {
  getPath: (_name: string) => userData
}

export default { app }

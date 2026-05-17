import { memo } from 'react'

import SavePath from './SavePath'
import DownloadQuality from './DownloadQuality'

export default memo(() => {
  return (
    <>
      <SavePath />
      <DownloadQuality />
    </>
  )
})

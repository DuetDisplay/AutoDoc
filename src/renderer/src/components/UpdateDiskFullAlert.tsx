import { useT } from '../services/i18n'
import { DiskFullAlert } from './DiskFullAlert'

/** Alert shown when downloading an update failed because the disk is full. */
export function UpdateDiskFullAlert({
  variant,
  onTryAgain,
  onDismiss
}: {
  variant: 'banner' | 'card'
  onTryAgain: () => void
  onDismiss?: () => void
}) {
  const t = useT()
  return (
    <DiskFullAlert
      variant={variant}
      title={t('ui.notEnoughSpaceToInstallTheUpdate')}
      body={t('ui.yourComputerIsAlmostOutOfDiskSpaceFreeUpSomeSpaceThenTryAgain')}
      actionLabel={t('ui.tryAgain')}
      onAction={onTryAgain}
      dismissLabel={t('ui.notNow')}
      onDismiss={onDismiss}
    />
  )
}

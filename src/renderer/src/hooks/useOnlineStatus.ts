import { useEffect, useState } from 'react'

/**
 * The browser's connectivity flag. `false` reliably means offline; `true` can
 * still fail (for example a network without internet), so download errors are
 * also checked with isNetworkErrorMessage.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

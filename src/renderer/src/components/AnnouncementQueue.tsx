import { useEffect, useState } from 'react'
import { MeetingLanguageAnnouncement } from './MeetingLanguageAnnouncement'
import { UiAppearanceAnnouncement } from './UiAppearanceAnnouncement'

export function AnnouncementQueue({
  suppressed,
  onVisibilityChange
}: {
  suppressed: boolean
  onVisibilityChange: (visible: boolean) => void
}) {
  const [pending, setPending] = useState<{ meeting: boolean; appearance: boolean } | null>(null)
  const [otherModalOpen, setOtherModalOpen] = useState(false)
  useEffect(() => {
    let active = true
    void Promise.all([
      window.electronAPI.invoke('prefs:get-meeting-language-announcement-pending'),
      window.electronAPI.invoke('prefs:get-ui-appearance-announcement-pending')
    ])
      .then(([meeting, appearance]) => {
        if (active) setPending({ meeting: meeting === true, appearance: appearance === true })
      })
      .catch(() => {})
    const check = () =>
      setOtherModalOpen(
        Array.from(
          document.querySelectorAll('dialog[open], [role="dialog"], [role="listbox"]')
        ).some((element) => !element.closest('[data-announcement]'))
      )
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'role']
    })
    check()
    return () => {
      active = false
      observer.disconnect()
    }
  }, [])
  const blocked = suppressed || otherModalOpen
  const meetingVisible = !!pending?.meeting && !blocked
  const appearanceVisible = !!pending?.appearance && !pending.meeting && !blocked
  useEffect(() => {
    onVisibilityChange(meetingVisible || appearanceVisible)
    return () => onVisibilityChange(false)
  }, [meetingVisible, appearanceVisible, onVisibilityChange])
  if (!pending) return null
  return (
    <>
      <MeetingLanguageAnnouncement
        pending={pending.meeting}
        suppressed={blocked}
        onVisibilityChange={() => {}}
        onDismiss={() => setPending((current) => current && { ...current, meeting: false })}
      />
      <UiAppearanceAnnouncement
        visible={appearanceVisible}
        onDismiss={() => setPending((current) => current && { ...current, appearance: false })}
      />
    </>
  )
}

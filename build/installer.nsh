!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove AutoDoc local data from this Windows account? This deletes recordings, settings, transcripts, and downloaded AI components." IDNO done
      RMDir /r "$APPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
    done:
  ${endif}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Also remove AutoDoc local data from this Windows account? This deletes recordings, settings, transcripts, and downloaded AI components." IDNO done
      ExpandEnvStrings $0 "%AUTODOC_TEST_USER_DATA_DIR%"
      ${if} $0 == "%AUTODOC_TEST_USER_DATA_DIR%"
        RMDir /r "$APPDATA\${APP_FILENAME}"
        !ifdef APP_PRODUCT_FILENAME
          RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        !endif
      ${else}
        RMDir /r "$0"
      ${endif}
    done:
  ${endif}
!macroend

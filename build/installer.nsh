!include "FileFunc.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    IfErrors maybe_prompt remove_data

    maybe_prompt:
      IfSilent done 0
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove AutoDoc local data from this Windows account? This deletes recordings, settings, transcripts, and downloaded AI components." IDYES remove_data IDNO done

    remove_data:
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

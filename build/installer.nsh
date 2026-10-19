!include "FileFunc.nsh"

; AutoDoc keeps its AI models under %ProgramData%\AutoDoc when the Windows profile path is not
; ASCII (the bundled Ollama cannot open such paths). The chosen folder is recorded in
; ollama-models-dir.txt inside the app data folder given in $R9. Remove it only when it is an
; AutoDoc models folder: the expected prefix followed by exactly the 12-character hash.
!macro autodocRemoveRelocatedModels
  ClearErrors
  FileOpen $1 "$R9\ollama-models-dir.txt" r
  ${IfNot} ${Errors}
    FileRead $1 $2
    FileClose $1
    ExpandEnvStrings $3 "%ProgramData%\AutoDoc\ollama-data-"
    StrLen $4 $3
    IntOp $5 $4 + 12
    StrLen $6 $2
    StrCpy $7 $2 $4
    ${If} $6 == $5
    ${AndIf} $7 == $3
      RMDir /r "$2"
    ${EndIf}
  ${EndIf}
!macroend

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
        StrCpy $R9 "$APPDATA\${APP_FILENAME}"
        !insertmacro autodocRemoveRelocatedModels
        RMDir /r "$APPDATA\${APP_FILENAME}"
        !ifdef APP_PRODUCT_FILENAME
          StrCpy $R9 "$APPDATA\${APP_PRODUCT_FILENAME}"
          !insertmacro autodocRemoveRelocatedModels
          RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        !endif
      ${else}
        StrCpy $R9 "$0"
        !insertmacro autodocRemoveRelocatedModels
        RMDir /r "$0"
      ${endif}
    done:
  ${endif}
!macroend

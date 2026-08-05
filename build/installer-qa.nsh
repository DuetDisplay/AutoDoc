!include "FileFunc.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    IfErrors maybe_prompt remove_data

    maybe_prompt:
      IfSilent done 0
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove AutoDoc QA local data from this Windows account? This deletes QA recordings, settings, transcripts, and downloaded AI components." IDYES remove_data IDNO done

    remove_data:
      RMDir /r "$APPDATA\AutoDoc QA"
    done:
  ${endif}
!macroend

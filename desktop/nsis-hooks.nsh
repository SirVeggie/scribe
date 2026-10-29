; Release installer hooks (npm run desktop:release).

; The daemon runs from the bundled Node in $INSTDIR\app, which keeps those files locked: stop it before they are
; replaced or removed.
!macro STOP_SCRIBE_DAEMON
  IfFileExists "$INSTDIR\app\node\node.exe" 0 +4
    nsExec::Exec '"$INSTDIR\app\node\node.exe" "$INSTDIR\app\dist\index.js" --stop'
    Pop $0
    Sleep 2000
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; A per-user install defaults to %LOCALAPPDATA%\Scribe, which is the daemon's data folder (src/config.ts).
  ; Keep the program out of it. Updates read the folder used before from the registry, so they don't land here.
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    SetOutPath $INSTDIR
  ${EndIf}
  !insertmacro STOP_SCRIBE_DAEMON
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro STOP_SCRIBE_DAEMON
!macroend

; Installer hooks (Tauri `bundle.windows.nsis.installerHooks`), as Vandal's.
;
; "Open with" for video files: Driveby is offered for these types (Explorer's Open with menu
; and list) but never made their default app; users can make it theirs. Tauri's own
; `fileAssociations` sets the extension's default class, which can take over types the user
; never explicitly assigned, so we register only OpenWithProgids and the Applications entry.
; Uninstall removes it all.

!define DRIVEBY_PROGID "Driveby.Video"

!macro DRIVEBY_OPEN_WITH EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${DRIVEBY_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro DRIVEBY_NO_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${DRIVEBY_PROGID}"
!macroend

; Keep in step with `editor::EXTENSIONS`.
!macro DRIVEBY_EACH_EXT MACRO
  !insertmacro ${MACRO} mp4
  !insertmacro ${MACRO} m4v
  !insertmacro ${MACRO} mov
  !insertmacro ${MACRO} mkv
  !insertmacro ${MACRO} gif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${DRIVEBY_PROGID}" "" "Video"
  WriteRegStr SHCTX "Software\Classes\${DRIVEBY_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${DRIVEBY_PROGID}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${DRIVEBY_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro DRIVEBY_EACH_EXT DRIVEBY_OPEN_WITH
  ; SHCNE_ASSOCCHANGED: let Explorer pick up the change now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DRIVEBY_EACH_EXT DRIVEBY_NO_OPEN_WITH
  DeleteRegKey SHCTX "Software\Classes\${DRIVEBY_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

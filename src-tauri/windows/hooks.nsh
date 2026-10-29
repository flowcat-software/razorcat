; Installer hooks (Tauri `bundle.windows.nsis.installerHooks`), as Vandal's.
;
; "Open with" for video files: Razorcat is offered for these types (Explorer's Open with menu
; and list) but never made their default app; users can make it theirs. Tauri's own
; `fileAssociations` sets the extension's default class, which can take over types the user
; never explicitly assigned, so we register only OpenWithProgids and the Applications entry.
;
; Projects (`.rct`, PLAN PR5) are Razorcat's own: it's their default app, with their own icon.
; Uninstall removes it all (`.rct`'s default only while it's still ours).

!define RAZORCAT_PROGID "Razorcat.Video"
!define RAZORCAT_PROJECT_PROGID "Razorcat.Project"

!macro RAZORCAT_OPEN_WITH EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${RAZORCAT_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro RAZORCAT_NO_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${RAZORCAT_PROGID}"
!macroend

; Keep in step with `editor::EXTENSIONS`.
!macro RAZORCAT_EACH_EXT MACRO
  !insertmacro ${MACRO} mp4
  !insertmacro ${MACRO} m4v
  !insertmacro ${MACRO} mov
  !insertmacro ${MACRO} mkv
  !insertmacro ${MACRO} webm
  !insertmacro ${MACRO} gif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROGID}" "" "Video"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROGID}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro RAZORCAT_EACH_EXT RAZORCAT_OPEN_WITH
  ; Projects: Razorcat opens them, by default.
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROJECT_PROGID}" "" "Razorcat project"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROJECT_PROGID}\DefaultIcon" "" "$INSTDIR\icons\project.ico,0"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROJECT_PROGID}\shell\open" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${RAZORCAT_PROJECT_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.rct" "" "${RAZORCAT_PROJECT_PROGID}"
  WriteRegStr SHCTX "Software\Classes\.rct\OpenWithProgids" "${RAZORCAT_PROJECT_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".rct" ""
  ; SHCNE_ASSOCCHANGED: let Explorer pick up the change now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro RAZORCAT_EACH_EXT RAZORCAT_NO_OPEN_WITH
  DeleteRegValue SHCTX "Software\Classes\.rct\OpenWithProgids" "${RAZORCAT_PROJECT_PROGID}"
  ReadRegStr $0 SHCTX "Software\Classes\.rct" ""
  StrCmp $0 "${RAZORCAT_PROJECT_PROGID}" 0 +2
    DeleteRegValue SHCTX "Software\Classes\.rct" ""
  DeleteRegKey /ifempty SHCTX "Software\Classes\.rct\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.rct"
  DeleteRegKey SHCTX "Software\Classes\${RAZORCAT_PROJECT_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\${RAZORCAT_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

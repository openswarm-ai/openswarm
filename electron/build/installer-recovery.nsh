; Bulletproof install/upgrade recovery for the "OpenSwarm cannot be closed"
; failure cascade.
;
; Three layers, each catching a different failure mode:
;
;   Layer A  pre-extract orphan kill (customInit)
;            Kills any OpenSwarm.exe + any python.exe / node.exe rooted
;            inside the install dir. Stops the dialog from EVER firing
;            because of subprocess holds.
;
;   Layer B  bulk-delete heavy dirs with REBOOTOK (customRemoveFiles)
;            Replaces NSIS's per-file delete loop on the four heavy dirs
;            (python-env, router, backend, app.asar) with a single
;            RMDir /r /REBOOTOK each. Faster than per-file (no Defender
;            lock-retry waterfall) and locked files defer to next boot
;            via MOVEFILE_DELAY_UNTIL_REBOOT instead of stalling.
;
;   Layer C  electron-builder's per-file silent retry stays as the safety
;            net for the remaining ~5% of files (anything not in the four
;            heavy dirs). No custom code needed — built into the framework.
;
; All layers run with the user's permissions (per-user install at
; %LOCALAPPDATA%). No admin elevation, no system-wide changes.
; taskkill targets only user-owned processes, wmic delete is filtered
; to install-dir-rooted processes.

!macro customInit
  ; ---- Layer A: pre-extract orphan kill ----
  ;
  ; Fires before NSIS extracts anything. The two killers below cover
  ; all the process-lock cases observed in the field:
  ;
  ;   1. App is running (user double-clicked installer without quitting)
  ;      → taskkill /F /IM OpenSwarm.exe /T cascades through children
  ;   2. App crashed and left orphan python.exe / node.exe with no parent
  ;      to taskkill via PID → PowerShell finds them by image path under
  ;      the install dir and force-kills them (wmic, the old approach, was
  ;      removed from Windows 11 24H2 and silently no-oped there)
  ;
  ; Both are safe (filter to install-dir-rooted processes only) and
  ; both no-op silently if no matching processes exist.

  nsExec::Exec 'taskkill /F /IM OpenSwarm.exe /T'
  Pop $0  ; discard exit code; non-fatal if no process matched

  ; Kill orphaned node/python whose image lives under the install dir (e.g.
  ; an App Builder vite node.exe that outlived a crash). A running .exe
  ; locks its own image, which would block the upgrade overwrite and
  ; surface "cannot be closed". Scoped by path so the user's own
  ; node/python stay untouched. PowerShell, not wmic, since wmic is gone
  ; from Windows 11 24H2. NSIS escaping: backtick-delimited so the inner "
  ; and ' are literals; $$ yields a literal $ (so $$_ becomes PowerShell $_).
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-Process node,python -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '*\Programs\OpenSwarm\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0

  ; Brief pause so Windows kernel releases handles before NSIS tries
  ; to delete the binaries in customRemoveFiles below. ~1.5s is enough
  ; in practice; longer here doesn't help and slows clean installs.
  Sleep 1500
!macroend

!macro customInstall
  ; ---- Defender prewarm: scan the heavy binaries while user is still watching the installer, not on first launch ----
  ;
  ; Right after extraction we spawn OpenSwarm.exe --prewarm, which loads
  ; python.exe and node.exe just enough to trigger Windows Defender's
  ; on-execute scan against them. Defender then has a cached verdict by
  ; the time the user double-clicks the app, dropping cold-start by
  ; 3-7 seconds on default-Defender Windows installs.
  ;
  ; --prewarm in main.js: no windows, no single-instance lock, no
  ; backend spawn, no UI side effects. Touches binaries via
  ; execFileSync('--version') and process.exit(0). 15s internal timeout
  ; per binary; outer nsExec call adds no further bound, so worst case
  ; this adds ~30-45s to install on a truly pathological machine.
  ; Standard machines: 3-8s.
  ;
  ; Failure here is silent and non-fatal. If --prewarm itself errors,
  ; the install still completes; user just pays the cold-start tax on
  ; first launch, same as before this macro existed.

  ; Skip prewarm on SILENT installs. CI's installer verification AND production
  ; auto-updates both run the installer with /S, and nsExec::Exec is synchronous
  ; with no upper bound - launching the freshly-extracted, not-yet-signed
  ; OpenSwarm.exe (which loads python.exe + node.exe) provokes a cold Windows
  ; Defender scan that can stall the silent install for minutes (it hung the CI
  ; installer check, and would do the same to a user's auto-update). Interactive
  ; first-time installs, where the cold-start win actually lands, still prewarm.
  ${If} ${Silent}
  ${Else}
    nsExec::Exec '"$INSTDIR\OpenSwarm.exe" --prewarm'
    Pop $0  ; discard exit code; prewarm is best-effort
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; ---- Layer B: bulk-delete heavy dirs with REBOOTOK fallback ----
  ;
  ; Runs in upgrade installs (no-op on first install since the dirs
  ; don't exist yet). Replaces NSIS's per-file delete loop for the
  ; four directories that contain ~95% of the file count, which is
  ; where Defender + Search indexer contention is concentrated.
  ;
  ; RMDir /r recursively removes the directory tree.
  ; /REBOOTOK schedules deletion via MOVEFILE_DELAY_UNTIL_REBOOT for
  ; any file that's currently locked — Windows commits the deletion
  ; on next boot before any process can re-acquire the handle.
  ; Net effect: no file lock can block the install. Worst case is
  ; one stale file lingering until reboot, which is invisible to
  ; the user since the new install writes fresh files alongside.
  ;
  ; The standard NSIS per-file loop still runs after this for the
  ; remaining ~5% of files (the few files at $INSTDIR\ root level),
  ; with electron-builder's built-in retry as safety net.

  RMDir /r /REBOOTOK "$INSTDIR\resources\python-env"
  RMDir /r /REBOOTOK "$INSTDIR\resources\router"
  RMDir /r /REBOOTOK "$INSTDIR\resources\backend"
  RMDir /r /REBOOTOK "$INSTDIR\resources\debugger"
  RMDir /r /REBOOTOK "$INSTDIR\resources\frontend"
  Delete /REBOOTOK "$INSTDIR\resources\app.asar"
  Delete /REBOOTOK "$INSTDIR\resources\elevate.exe"
  Delete /REBOOTOK "$INSTDIR\OpenSwarm.exe"
!macroend

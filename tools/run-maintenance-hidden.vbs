' Launches the GrokWorkerProviderMaintenance task's command with zero visible
' window. The original scheduled task invokes cmd.exe directly (a console
' subsystem app with no window-hiding of its own), which flashes a visible
' console every time it fires (every 30 minutes). wscript.exe is not a
' console-subsystem app, so launching through it avoids the flash entirely.
' The launch mechanism is the only thing this changes.
'
' Paths come from the environment rather than being hard-coded to one machine's
' user name. The shim is installed by `grok-worker deploy pointer --write`.

Dim q, cmdLine, shim, workDir
q = Chr(34)

Set objShell = CreateObject("WScript.Shell")

shim    = objShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.local\bin\grok-worker.cmd"
workDir = objShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\GrokWorkerProvider"
cmdLine = objShell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\cmd.exe /d /s /c " _
          & q & q & shim & q & " pool maintenance tick" & q

objShell.CurrentDirectory = workDir
objShell.Run cmdLine, 0, False

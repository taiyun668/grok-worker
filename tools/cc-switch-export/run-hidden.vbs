' Launches run-scheduled.ps1 with zero visible window (not even a brief
' flash). wscript.exe is not a console-subsystem app, so unlike invoking
' powershell.exe directly (even with -WindowStyle Hidden), Windows never
' needs to allocate/flash a console buffer for this launch step. The 0
' windowStyle also propagates to the powershell.exe child it starts.
Set objShell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scheduledScript = fileSystem.BuildPath(scriptDir, "run-scheduled.ps1")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scheduledScript & """", 0, False

' Launches run-scheduled.ps1 with zero visible window (not even a brief
' flash). wscript.exe is not a console-subsystem app, so unlike invoking
' powershell.exe directly (even with -WindowStyle Hidden), Windows never
' needs to allocate/flash a console buffer for this launch step. The 0
' windowStyle also propagates to the powershell.exe child it starts.
Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\Grok Worker Provider\tools\cc-switch-export\run-scheduled.ps1""", 0, False

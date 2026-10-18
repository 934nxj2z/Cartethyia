' Launches a command with no console window at all.
'
' Why a VBS: `wscript.exe` is a GUI-subsystem host, so it never allocates a
' console for itself. Everything it starts with window style 0 inherits that —
' no console window is shown, and none is left behind. That is different from
' spawning the child directly: a console-subsystem child spawned from a
' window-less parent gets a new console unless CREATE_NO_WINDOW is passed, and
' when the parent lives inside Windows Terminal the tab is already open before
' any flag can take effect.
'
' Usage: wscript.exe //nologo launch-hidden.vbs <exe> [args...]
' The third argument (True) would make wscript wait for the child; it must stay
' False so the launcher returns immediately and the child outlives it.

Set shell = CreateObject("WScript.Shell")

command = ""
For Each arg In WScript.Arguments
  If command <> "" Then command = command & " "
  command = command & """" & arg & """"
Next

If command = "" Then
  WScript.Quit 2
End If

' 0 = hidden window, False = do not wait.
shell.Run command, 0, False

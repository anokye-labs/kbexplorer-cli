@echo off
REM Windows launcher for the deterministic agent-runtime twin (issue #59).
REM Lets KBEXPLORER_COPILOT_BIN / KBEXPLORER_CLAUDE_BIN point straight at a
REM single executable path that the runtime can spawn with shell:false.
REM Forwards all argv to the .mjs and exits with its code.
node "%~dp0fake-agent.mjs" %*

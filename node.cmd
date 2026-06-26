@echo off
setlocal

set "PORTABLE_NODE=C:\Users\Chris\AppData\Local\Programs\NodePortable\node-v24.14.0-win-x64\node.exe"

if exist "%PORTABLE_NODE%" (
  "%PORTABLE_NODE%" %*
  exit /b %errorlevel%
)

if defined npm_node_execpath (
  "%npm_node_execpath%" %*
  exit /b %errorlevel%
)

echo AutoDoc could not find Node.js. Expected "%PORTABLE_NODE%" or npm_node_execpath.
exit /b 1

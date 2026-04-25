@echo off
echo Installing dependencies (npm install)...
call npm install

echo.
echo Running npm audit fix...
call npm audit fix

echo.
echo Starting the application...
call npm run dev


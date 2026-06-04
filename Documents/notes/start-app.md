# Start And Stop The App Manually

These commands assume PowerShell is open in the project root:

```powershell
cd D:\MyProjects\Web\isputnik.home
```

## Start

Use one terminal to run both the API server and the web app:

```powershell
npm run dev
```

When startup is complete, open:

```text
http://127.0.0.1:5173/
```

The app uses:

- Web app: `http://127.0.0.1:5173/`
- API server: `http://127.0.0.1:4000/`

## Stop

If the terminal running `npm run dev` is still open, press:

```text
Ctrl+C
```

If the app was started in the background or the terminal was closed, stop the processes using the ports:

```powershell
Get-NetTCPConnection -LocalPort 4000,5173 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```

## Check Whether It Is Running

```powershell
Get-NetTCPConnection -LocalPort 4000,5173 -ErrorAction SilentlyContinue |
  Select-Object LocalPort,State,OwningProcess
```

You can also check the web app directly:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing
```
